FROM oven/bun:1

WORKDIR /app

# 相依(依 lockfile,零 runtime 相依但仍需 devDeps 供 bun 執行 TS)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# 純 bun 常駐排程器(對齊 4h,UTC)。前景執行,容器常駐。
# 不用 supercronic:其 arm64 binary 在本機 colima 容器有 fork/exec 相容問題。
CMD ["bun", "scripts/scheduler.ts"]
