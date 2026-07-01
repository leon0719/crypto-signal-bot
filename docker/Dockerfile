FROM oven/bun:1

WORKDIR /app

# supercronic:容器內 cron 排程器(靜態單一 binary)。arm64(colima/Apple Silicon)。
ENV SUPERCRONIC_VERSION=v0.2.33
ADD https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-arm64 /usr/local/bin/supercronic
RUN chmod +x /usr/local/bin/supercronic

# 相依(依 lockfile,零 runtime 相依但仍需 devDeps 供 bun 執行 TS)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# 排程器前景執行,容器常駐
CMD ["supercronic", "/app/docker/crontab"]
