# Conviction AI Media, News, Preferences, and Telegram Support Infrastructure

## Scope
Conviction Markets uses AI to make activity feeds richer without inventing market facts. The system can produce media briefs, event cards, news feed summaries, and support answers from real market, social, and product context. User-facing media should use the market headline, official Conviction branding, current stored odds, and neutral wording. User post text is not placed inside generated event images.

## Secret Management
Secrets live in Vercel/project environment variables only. They are never committed to GitHub and never sent to the browser.

Required frontend/server env:
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL=https://share-ai.ckbdev.com`
- `OPENAI_MEDIA_MODEL=gpt-5.5`
- `OPENAI_SUPPORT_MODEL=gpt-5.5`

Required Telegram support env:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SUPPORT_CHAT_ID`


## Telegram Notification Setup
Use Telegram only for human support escalation.

1. Open Telegram and message `@BotFather`.
2. Run `/newbot`, choose a bot name, and copy the bot token. Save it in the core API Vercel project as `TELEGRAM_BOT_TOKEN`.
3. Create a private Telegram group such as `Conviction Support Alerts`.
4. Add the bot to that group. If it is a channel, make the bot an admin so it can post.
5. Send one message in the group, for example `support test`.
6. Open this URL in a browser, replacing `<BOT_TOKEN>` with the token from BotFather:
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
7. In the JSON response, find `message.chat.id` or `channel_post.chat.id`. Group ids usually start with `-`. Save that value in the core API Vercel project as `TELEGRAM_SUPPORT_CHAT_ID`.
8. Redeploy the core API after adding both env vars.

If `getUpdates` returns an empty result, send `/start@your_bot_username` in the group, or ask BotFather to disable privacy for the bot with `/setprivacy`, then send another group message and reload the URL.


## Telegram Bot Runtime
Current support group chat id from `getUpdates`:
- `TELEGRAM_SUPPORT_CHAT_ID=-4910208424`

Required core production env:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SUPPORT_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `CORE_PUBLIC_URL=https://conviction-core-api.vercel.app`

After deploying core, point Telegram at the webhook:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://conviction-core-api.vercel.app/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>
```

Group commands:
- `/chatid` shows the current group id.
- `/role support` registers the group for support tickets.
- `/role alerts` registers the group for market digest alerts.
- `/role general` keeps the group as a general bot group.
- `/markets` posts a live digest from stored Conviction market data.
- `/status` shows the bot setup status for that chat.

A bot will not reply in a group until the Telegram webhook is set. Privacy mode can stay disabled if the group should allow non-command monitoring later, but the current implementation only responds to commands.

## User Preference Flow
1. A connected wallet creates or resumes a core user session.
2. The user chooses topics, regions, preferred sports/markets, preferred media type, and news cadence.
3. Preferences are stored against `userId` in core.
4. Activity feed queries can use these preferences to rank news and market updates.
5. If a guest tries to personalize, the frontend prompts wallet connection first.

Default topics include Sports, World Cup, Crypto, Politics, Geopolitics, Finance, Tech, Culture, Economy, Weather, Breaking, and Local/Global regions.

## Activity News + Media Flow
1. Scheduled or manual feed generation reads active markets and user preferences.
2. Core creates feed items from real market records only.
3. AI may summarize context or generate a media brief, but it must not invent odds, winners, price movement, or execution claims.
4. Media records store image/video URLs or renderer URLs. Template cards are the fallback when AI/media generation is unavailable.
5. Frontend Activity displays personalized news items every configured cadence, starting with a 20 minute default.

## Publish/Post Media Flow
1. User publishes a market call.
2. Core stores the post as a trade signal/social record.
3. Frontend share URLs point to Conviction public routes.
4. Public routes expose Open Graph, Twitter, and Farcaster metadata.
5. Generated media image uses the market title as headline and Conviction logo. The user post remains in the feed body, not inside the image.

## AI Support Flow
1. User opens Support.
2. AI answers using Conviction product context: market discovery, activity/social layer, wallet/profile flow, margin flow, vault flow, testnet limits, and docs.
3. If the answer needs human intervention, the user is asked for an email and a clear issue summary.
4. Core stores a support ticket with `userId`, email, wallet context if available, summary, transcript, and status.
5. Core sends a Telegram alert to the configured support chat.
6. Human follow-up happens by email or Telegram admin workflow. WhatsApp is intentionally out of scope.

## Backend Responsibilities
- Store user preferences.
- Store support tickets and support messages.
- Store AI/news/media feed records.
- Provide AI-safe context endpoints for frontend support UI.
- Send Telegram escalation notifications.
- Enforce privacy: private trades and private profile data must not leak into public feed or AI context.

## Frontend Responsibilities
- Prompt users to set preferences after wallet/profile setup.
- Show personalized news/media in Activity.
- Let users view public posts from other users.
- Provide support chat and human escalation form.
- Never expose server API keys.
- Keep generated media lightweight: image templates first, video templates second, full AI video only after provider/cost review.

## Media Provider Strategy
Phase 1 uses deterministic Conviction card rendering and AI media briefs.
Phase 2 can add template-based video rendering for market updates.
Phase 3 can connect an external media generation provider once cost, latency, moderation, and rights are reviewed.

## Safety Rules
- Do not claim a market outcome is likely unless real odds are shown as odds.
- Do not present AI summaries as resolution rules.
- Do not invent liquidity, volume, PnL, fills, or leverage execution.
- Do not include user emails in public user discovery.
- Do not include private trades in social or AI feed context.
