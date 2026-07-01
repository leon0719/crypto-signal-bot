.PHONY: help up down build rebuild logs run docker-clean

COMPOSE = docker compose -f docker/docker-compose.yml

help:
	@echo "========================================"
	@echo "  crypto-signal-bot 偵測推播器 (Docker)"
	@echo "========================================"
	@echo ""
	@echo "  make up            - 建構並啟動常駐偵測器 (每 4h 掃描)"
	@echo "  make down          - 停止容器"
	@echo "  make build         - 僅建構映像 (不啟動)"
	@echo "  make rebuild       - 重新建構並啟動 (改 Dockerfile/程式碼後用)"
	@echo "  make logs          - 追蹤容器日誌"
	@echo "  make run           - 立即跑一次掃描 (不等 cron,用於測試)"
	@echo "  make docker-clean  - 停止並清理資料卷與本地 data/"
	@echo ""
	@echo "首次使用:cp .env.local.example .env.local 後填入 SLACK_BOT_TOKEN"

up:
	$(COMPOSE) up -d --build
	@echo ""
	@echo "偵測器已啟動!每 4h(收棒後 2 分,UTC)掃描一次,有新機會推 Slack #cry"
	@echo "  查看日誌:make logs"

down:
	$(COMPOSE) down

build:
	$(COMPOSE) build

rebuild:
	$(COMPOSE) up -d --build

logs:
	$(COMPOSE) logs -f

run:
	$(COMPOSE) run --rm detector bun scripts/detect.ts

docker-clean:
	$(COMPOSE) down -v
	rm -rf data/
	@echo "Docker 資料卷與本地 data/ 已清理"
