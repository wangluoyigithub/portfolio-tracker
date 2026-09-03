# 基金股票个人账户管理

个人使用的基金、股票、ETF 与可转债账户管理网页。程序镜像与 SQLite 数据库分离，
适合通过 NAS 的 Docker Compose 部署。

## 使用最新镜像部署

下载仓库根目录的 `docker-compose.yml` 和 `.env.example`，放进 NAS 的同一个项目目录：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
PORTFOLIO_BIND_IP=192.168.1.20
PORTFOLIO_WEB_PORT=18080
PORTFOLIO_VERSION=latest
```

`PORTFOLIO_BIND_IP` 必须改为 NAS 的局域网 IP。不要使用公网 IP，也不要在路由器中
为该端口设置公网转发。保留默认 `127.0.0.1` 时只有 NAS 本机或本机反向代理可以访问。

启动：

```bash
docker compose up -d portfolio
```

数据库保存在项目目录的 `data/portfolio.db`，不会进入镜像或 GitHub。
首次打开网页会进入设置页，请创建登录账号和至少 8 位密码。登录账号和密码只以
加盐哈希保存在该数据库中，不会写入 YAML、镜像或 GitHub。

## 手动备份

更新前执行 SQLite 在线备份：

```bash
docker compose run --rm backup
```

备份保存在 `data/backups/`。

## 自动备份后更新

保持 `.env` 中的 `PORTFOLIO_VERSION=latest`，执行：

```bash
./update-image.sh
```

脚本会先使用当前正在运行的版本创建 SQLite 一致性备份，成功后才拉取和启动最新镜像。
需要回退时，把版本号改为 `1.0.0` 等固定版本，再运行相同命令。

## 本地构建

不使用 GHCR 时可以从源码构建：

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build portfolio
```

更多使用说明见 [webapp/README.md](webapp/README.md)。
