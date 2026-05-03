# 小二对决 (Xiaoer Duel)

A web-based magical duel game where players cast spells (typed text) and an AI judges their power and effects.

## Tech Stack

- **Backend**: FastAPI + WebSocket
- **Frontend**: Vanilla HTML/CSS/JS (mobile-first)
- **AI**: ZhipuAI GLM for spell judging
- **Deploy**: Docker Compose + Caddy (auto HTTPS)

## Local Dev

```bash
./start.sh
# Open http://localhost:8765
```

## Deploy

See `scripts/bootstrap-server.sh` for one-command server setup.
After bootstrap, every push to `main` auto-deploys via GitHub Actions.

## Game Rules

Two players take turns typing spells. The AI judges each spell's:
- **Power** (0–30) based on creativity & flair
- **Type**: attack / field effect / heal / bind / break

Combat uses derived stats (HP, shield, dodge, defense). First to 0 HP loses.
