# Risk Architecture

| Guardrail | Value | Behavior |
|-----------|-------|----------|
| Hard stop loss | −3% from entry | `stop_loss_pct: 0.03` |
| Trailing stop | −5% from peak | `trailing_stop_pct: 0.05` |
| Green threshold | +1% | Promotes to trailing stop mode, cancels time stop |
| Time stop | 30 min | If not profitable by then, exit |
| Short squeeze protection | +5% intraday | Cover immediately on squeeze |

**Everything else — sizing, position count, risk per trade, strategy selection — is the trader's domain.**