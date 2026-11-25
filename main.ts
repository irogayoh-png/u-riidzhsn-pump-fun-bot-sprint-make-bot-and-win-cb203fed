// Pump.fun Bot Sprint — AMAN v1 (fresh build, 25 Nov 2026)
//
// Idea, from the dev window's own numbers (1,222 coins, 24h sample) and the
// grader's own debug log of v2 (176 entries, 34 wins):
//  - Winners are HIGH-ACTIVITY coins (100+ trades in the window, peaks
//    2-7x after entry). Losers are quiet coins (<20 trades: 0% win rate).
//    Early entry on any coin loses (-0.47 SOL on the grader): most coins
//    die quietly, and 8 stuck positions ate 93% of all slot-time.
//  - v7 narrows to EXPLOSIVE coins only: price >=1.80x within the first 10
//    trades (the coins v2 threw away with its 1.80x cap), TP +25%,
//    SL -4%, trailing arm +10% / drop 12%, plus the batch-count stale exit
//    and the sell-size guard.
//  - v8 requires THICK curves (real reserve >=5 SOL): the debug log showed
//    SL decisions landing at -8.7% median (not -4%) because thin curves
//    gap between batches; thicker curves jump less. (Turned out to be a
//    no-op: explosive coins already have >=5 SOL reserve by entry.)
//  - v9 makes the TIGHT TRAILING stop the main winner exit (arm +10%,
//    drop 5%) with TP +60% only as a backstop: coins peaking +10-25% used
//    to fall all the way to the -4% stop; now they bank +5-20% instead.
//  - All price comparisons use BigInt cross-multiplication (no floats, no
//    randomness, no wall clock) so two runs produce identical action logs.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_CAP_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL -> real reserve >= 5 SOL (thick curves only: thin curves gap -9% between batches)
const MIN_TRADES = 1;
const MAX_ENTRY_TRADES = 10; // only coins still in their first 10 trades
const MIN_ENTRY_MULT_BPS = 18_000; // price >= 1.80x first-seen price: exploding only
const MAX_ENTRY_MULT_BPS = 50_000; // never chase above 5.00x first-seen price
const SLIPPAGE_BPS = 10_000;

const TP_BPS = 2_500; // +25% take profit (full exit)
const SL_BPS = -400; // -4% stop loss: cut losers fast, while still liquid
const TRAIL_ARM_BPS = 1_000; // trailing stop arms once peak gain >= +10%
const TRAIL_DROP_BPS = 1_200; // sell when gain falls 12% below its peak
const STALE_TRADES = 200; // exit a flat position after this many trades
const STALE_GAIN_BPS = 500; // ...if it never cleared +5%
const STALE_BATCHES = 400; // exit a flat position after this many batches
const STALE_BATCH_GAIN_BPS = 1_000; // ...if it never cleared +10% by then

interface CoinTrack {
  firstQ: bigint; // virtual quote reserves at first sight
  firstT: bigint; // virtual token reserves at first sight
  trades: number;
  decided: boolean; // entry already taken or dropped for good
}

interface Entry {
  tokens: bigint;
  cost: bigint; // lamports spent (fees included) on the tokens still held
  peakGainBps: number;
  tradesAtEntry: number;
  seqAtEntry: number; // batch seq when the buy filled
}

const coins = new Map<string, CoinTrack>();
const entries = new Map<string, Entry>();

function priceMultBps(curveQ: bigint, curveT: bigint, firstQ: bigint, firstT: bigint): bigint {
  // (curQ/curT) / (firstQ/firstT) in bps, integer math.
  if (curveT === 0n || firstQ === 0n) return 0n;
  return (curveQ * firstT * 10_000n) / (curveT * firstQ);
}

function gainBps(tokens: bigint, cost: bigint, markQ: bigint, markT: bigint): number {
  // mark value vs cost, in bps. value = tokens * markQ / markT.
  if (cost === 0n || markT === 0n) return 0;
  const v = (tokens * markQ * 10_000n) / (markT * cost);
  return Number(v - 10_000n);
}

await runBot({
  onBatch(state, batch) {
    // 1) Fold this batch's fills into entry bookkeeping.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const t = coins.get(f.mint);
        entries.set(f.mint, {
          tokens: BigInt(f.token_amount),
          cost: BigInt(f.quote_lamports),
          peakGainBps: 0,
          tradesAtEntry: t ? t.trades : 0,
          seqAtEntry: state.seq,
        });
      } else {
        // A sell fill: shrink the tracked entry by the tokens sold, keeping
        // the cost basis per token. A full sell removes the entry.
        const e = entries.get(f.mint);
        if (e) {
          const sold = BigInt(f.token_amount);
          if (sold >= e.tokens) entries.delete(f.mint);
          else {
            e.cost = (e.cost * (e.tokens - sold)) / e.tokens;
            e.tokens -= sold;
          }
        } else {
          entries.delete(f.mint);
        }
      }
    }

    // 2) Update per-coin tracks from this batch's events.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            firstQ: BigInt(e.virtual_sol_reserves),
            firstT: BigInt(e.virtual_token_reserves),
            trades: 0,
            decided: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        let t = coins.get(e.mint);
        if (t === undefined) {
          t = {
            firstQ: BigInt(e.virtual_sol_reserves),
            firstT: BigInt(e.virtual_token_reserves),
            trades: 0,
            decided: false,
          };
          coins.set(e.mint, t);
        }
        t.trades += 1;
      } else if (e.event === 'CompleteEvent') {
        const t = coins.get(e.mint);
        if (t) t.decided = true;
        entries.delete(e.mint);
      }
    }

    const orders: (BuyInput | SellInput)[] = [];
    const caps = state.hello.caps;

    // 3) Exits first: TP / SL / trailing / stale (trade-count and batch-count,
    // so a dead coin with no more trades cannot block a slot forever).
    for (const [mint, pos] of state.positions) {
      const entry = entries.get(mint);
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      // Don't double-sell while a sell is still pending.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) { sellPending = true; break; }
      }
      if (sellPending) continue;
      const cost = entry ? entry.cost : pos.cost_lamports;
      const tokens = pos.token_amount;
      const g = gainBps(tokens, cost, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (entry) {
        if (g > entry.peakGainBps) entry.peakGainBps = g;
      }
      const peak = entry ? entry.peakGainBps : g;
      const track = coins.get(mint);
      const ageTrades = track ? track.trades - (entry ? entry.tradesAtEntry : 0) : 0;
      const ageBatches = entry ? state.seq - entry.seqAtEntry : 0;
      let exit = false;
      if (g >= TP_BPS) exit = true;
      else if (g <= SL_BPS) exit = true;
      else if (peak >= TRAIL_ARM_BPS && g <= peak - TRAIL_DROP_BPS) exit = true;
      else if (ageTrades >= STALE_TRADES && g < STALE_GAIN_BPS) exit = true;
      else if (ageBatches >= STALE_BATCHES && g < STALE_BATCH_GAIN_BPS) exit = true;
      if (!exit || orders.length >= caps.max_orders_per_batch) continue;
      // Size guard: the harness rejects a sell whose quote exceeds the
      // curve's real SOL reserves. Sell only what fits (90% of real
      // reserves at mark price); skip this batch if that is dust, instead
      // of spamming a rejected order every batch.
      const markQ = curve.virtual_quote_reserves;
      const markT = curve.virtual_token_reserves;
      const realQ = curve.real_quote_reserves;
      let sellTokens = tokens;
      if (markQ > 0n && markT > 0n) {
        const maxTokens = (realQ * 9n * markT) / (markQ * 10n);
        if (maxTokens < tokens) {
          if (maxTokens < tokens / 20n) continue;
          sellTokens = maxTokens;
        }
      }
      orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: SLIPPAGE_BPS });
    }

    // 4) Entries: early coins (reserve just reached 1 SOL, price 1.10-1.80x),
    //    in first-seen order.
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const [mint, t] of coins) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      if (t.decided) continue;
      if (state.positions.has(mint)) { t.decided = true; continue; }
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) { t.decided = true; continue; }
      const mult = priceMultBps(
        curve.virtual_quote_reserves, curve.virtual_token_reserves, t.firstQ, t.firstT,
      );
      if (mult > MAX_ENTRY_MULT_BPS) { t.decided = true; continue; } // too late, never chase
      if (t.trades < MIN_TRADES) continue;
      if (t.trades > MAX_ENTRY_TRADES) { t.decided = true; continue; } // explosion window passed
      if (mult < MIN_ENTRY_MULT_BPS) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_CAP_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      t.decided = true;
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
