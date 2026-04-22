# Yahoo 拍賣價格監測 Bot

## 功能
- 監測日本 Yahoo 拍賣商品價格
- 價格達標時通過 Telegram 推送通知
- 支持指令：`監測 商品ID 目標價格` / `列表` / `停止`

## 部署到 Vercel
1. 連接 GitHub 倉庫到 Vercel
2. 配置環境變數：
   - `MONGODB_URI` - MongoDB 連接字符串
   - `TELEGRAM_BOT_TOKEN` - Telegram Bot Token
   - `TELEGRAM_CHAT_ID` - 你的 Chat ID
3. 部署完成後訪問 `/api/health` 確認運行

## 使用方式
添加任務：
```
https://bot.wearmo.app/api/cmd?cmd=監測%20商品ID%2010000
```
