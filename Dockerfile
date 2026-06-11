# 使用官方轻量级 Bun 镜像
FROM oven/bun:1.1-slim

# 设置容器内工作目录
WORKDIR /app

# 复制依赖描述文件并安装生产依赖
COPY package.json package-lock.json ./
RUN bun install --production

# 复制项目源代码和前端静态网页
COPY tsconfig.json ./
COPY src/ ./src/
COPY static/ ./static/
COPY data/ ./data/

# 预先创建必要的目录并提供默认配置副本
RUN mkdir -p /app/results

# 暴露 Hono 网页服务的默认端口
EXPOSE 28080

# 启动 Web 服务
CMD ["bun", "run", "src/server.ts"]
