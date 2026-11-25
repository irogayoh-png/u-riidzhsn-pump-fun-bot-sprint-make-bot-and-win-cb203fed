[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/irogayoh-png/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/irogayoh-png/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint: Make Bot And Win

A paper-trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on [make.fun](https://make.fun). It trades paper SOL on a replay of pump.fun bonding-curve data — no real SOL, no real wallet, no real coins are bought.

## Strategy

Explosive-entry swing trading, tuned on the dev window (1,222 coins, 24h):

- **Entry:** a coin that explodes to **>=1.80x** its creation price within its first **10 trades**, once its real SOL reserve reaches **5 SOL** (thick curves only — thin curves gap between batches). One buy per coin, up to **0.05 SOL**, at most 5 open positions.
- **Exit:** take-profit **+25%**, stop-loss **-4%**, trailing stop (arms at +10%, sells 12% below the peak), plus a batch-count stale exit so a dead coin cannot block a slot forever.
- **Safety:** sells are sized to what the curve's real reserves can absorb, so a dead coin never spams rejected orders. All price math uses integer cross-multiplication — no floats, no randomness, no wall clock — so two runs produce identical action logs.

## Local results (dev, `grade-local --driver process`)

| version | net PnL | coins | win rate | max drawdown |
| --- | --- | --- | --- | --- |
| v7 (this entry) | -0.41 SOL | 161 | 26% | 4.6% |

Earlier variants (momentum entry, early entry, fast exits, partial take-profit, late entry on proven-active coins, tight trailing) all scored worse on the same dev window, as did every house pilot shipped in the kit (best pilot: sniper, -0.47 SOL). The dev window is a hard, mean-reverting sample; this entry is the least-bad and most robust of the family tested.

## Layout

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte-identical to `sdk/ts/makefun-bot.ts`.
- `LICENSE` — MIT.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```
