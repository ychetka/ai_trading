<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] Original deployment guide: SMC AI Analyst on Debian 13

> Original draft instruction (the first iteration). The production
> system ended up fully rootless — the actual stack is described in the
> project README; this file is kept for history only.

Target environment (as drafted):
- OS: Debian 13 (Trixie)
- CPU: AMD FX (x86_64)
- Profile: self-hosted JS/TS automation backend (n8n + localtunnel +
  OpenRouter API)

## Stage 1: System update and Docker Engine

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git uidmap coreutils ca-certificates
curl -fsSL https://docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

(Note: the deployed system never used this — the machine had no sudo;
the rootless static-binary stack in `docker-static/` replaced it.)

## Stage 2: nvm + Node.js LTS

```bash
curl -o- https://githubusercontent.com | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install --lts && nvm use --lts
node -v && npm -v
```

## Stage 3: n8n via Docker Compose (persistent SQLite volume)

```bash
mkdir -p ~/crypto-analyst && cd ~/crypto-analyst
cat << 'EOF' > docker-compose.yml
version: '3.8'
volumes:
  n8n_storage:
    external: false
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    container_name: n8n-crypto-bot
    restart: always
    ports: ["5678:5678"]
    environment:
      - N8N_HOST=localhost
      - N8N_PORT=5678
      - N8N_PROTOCOL=http
      - NODE_ENV=production
      - WEBHOOK_URL=https://localtunnel.me
    volumes:
      - n8n_storage:/home/node/.n8n
EOF
docker compose up -d && docker ps
```

## Stage 4: Localtunnel for inbound webhooks

So that TradingView cloud could POST to a PC behind NAT without a
static IP:

```bash
npm install -g localtunnel
# run persistently via screen/tmux or pm2:
# lt --port 5678 --subdomain mysmcbot
```

## Stage 5: TradingView alert payload structure

The alert **Message** field had to carry strictly-valid JSON:

```json
{
  "ticker": "{{ticker}}",
  "price": "{{close}}",
  "ob_low": "{{plot(\"OB Low\")}}",
  "volume_poc": "{{plot(\"Volume POC\")}}",
  "btc_price": "{{ticker(\"BYBIT:BTCUSDT.P\", \"close\")}}"
}
```

## Stage 6: Original minimal n8n workflow (import via Ctrl+V)

Three nodes: `Webhook from TradingView` → `OpenRouter Free AI`
(httpRequest, header auth `openrouter-header-key`) → `Send to Telegram`
(telegramApi `telegram-bot-token`, chat `YOUR_PERSONAL_CHAT_ID`,
parse_mode Markdown, text `={{ $json.choices[0].message.content }}`).

The original prompt embedded in the OpenRouter node (translated):

```
You are a professional risk manager and AI analyst of the crypto futures
market. Your task is to compute a conditional long order from SMC and
Volume Profile data.

Incoming data:
- Asset: {{ $json.body.ticker }}
- Current price: {{ $json.body.price }}
- Order Block lower bound (OB Low): {{ $json.body.ob_low }}
- Volume POC level: {{ $json.body.volume_poc }}
- Leader (BTC): {{ $json.body.btc_price }}

RULES:
1. Entry strictly 10–20 points above Volume POC or the OB level.
2. Hide the stop below OB Low.
3. Risk is always 100 USDT. Qty = 100 / (Entry - Stop).
4. If BTC is overheated, state that market entry is FORBIDDEN.

Output a structured Telegram verdict (ticker, context, order params).
```
