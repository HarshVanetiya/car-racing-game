# Deploying Apex Circuit

The game splits cleanly in two, and that shapes every choice here:

- **The client is a folder of static files.** Single player — quick race,
  practice, time trial, qualifying, a full race weekend against the AI — runs
  entirely in the browser with no backend at all.
- **The race server is only needed for multiplayer.** It is a long-lived Node
  process holding WebSocket connections and running an authoritative
  simulation, which is a genuinely different hosting problem.

So deploy the client first. It is free forever, needs no account beyond the
GitHub one you already have, and it is all you need to answer "how does this
actually run on my machine".

---

## Step 1 — the client, on GitHub Pages

**Cost:** free. **Card:** none. **Account:** the GitHub one you have.

`.github/workflows/pages.yml` already does the work. You only need to switch
Pages on:

1. Go to the repository → **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab, pick **Deploy to GitHub Pages**, and press
   **Run workflow** (or just push a commit — it runs on every push to the
   default branch).

The game lands at:

```
https://<your-username>.github.io/car-racing-game/
```

The workflow runs the test suite before it builds, so a broken commit never
reaches the published game.

**If your repository is private**, Pages needs GitHub Pro. The Student Pack
includes Pro, so this works — but the simpler answer is to make the repository
public.

### Measuring the thing you actually wanted to measure

Once it is live, open the browser's own tools rather than trusting a feeling:

- **Frame rate**: Chrome/Edge → `⋮` → More tools → **Rendering** → tick
  **Frame Rendering Stats**. Firefox has the same under `about:config` →
  `gfx.webrender.debug.profiler`.
- **Where the time goes**: DevTools → **Performance** → record a few seconds of
  driving. Long purple "Render"/"GPU" bars mean the graphics card is the limit;
  long yellow "Scripting" bars mean the CPU is.
- **Settings → Quality**: drop it to Low and see what changes. Low renders at
  80% resolution and turns shadows off, which are the two most expensive things
  in the frame. If Low is smooth and High is not, the GPU is your limit and
  nothing about the physics is wrong.

---

## Step 2 — the race server, on Render

**Cost:** free. **Card:** none. **Account:** a new Render account (sign in with
GitHub).

Render's free tier is the right fit for this because it does the one thing most
free hosts do not: **it supports WebSockets and long-lived processes.** Serverless
platforms — Vercel, Netlify, Cloudflare Workers — are built around short-lived
requests, and an authoritative race server holding sockets open at 20 snapshots
a second is the opposite of that.

1. Go to [render.com](https://render.com) and sign up with your GitHub account.
2. **New** → **Blueprint**, and point it at this repository. Render reads
   `render.yaml` and configures the service itself.
   *(Or: **New** → **Web Service**, pick the repo, runtime **Node**, build
   `npm ci && npm run build`, start `npm start`, plan **Free**.)*
3. Wait for the first deploy. You get a URL like
   `https://apex-circuit.onrender.com`.
4. Visit it. The server serves the built client too, so that URL alone is a
   complete, playable deployment.

### Pointing the Pages client at it

So that the fast-loading Pages copy can also play multiplayer:

1. Repository → **Settings** → **Secrets and variables** → **Actions** →
   **Variables** tab → **New repository variable**.
2. Name it `APEX_SERVER_URL`, value `https://apex-circuit.onrender.com`
   (your Render URL, no trailing slash).
3. Re-run the Pages workflow.

The client converts that to a `wss://` socket address itself. A page served
over HTTPS may only open a secure socket, which Render provides — this is why
a plain IP address or a bare `http://` host will not work.

The free tier's one real limit — the service sleeping — has its own section
below, along with two ways around it.

---

## The free tier sleeping, and what to do about it

A free Render service sleeps after 15 minutes idle. Worth being precise about
what that actually costs, because it is smaller than it sounds: **the client is
on GitHub Pages and never sleeps**, so the game always loads instantly. Only
the multiplayer lobby waits, and only for the first person to open it — 30 to
60 seconds, once, after which everyone else joins normally.

If that is still annoying, there are two answers.

**Free: keep it awake.** `.github/workflows/keepalive.yml` pings the server
every ten minutes. It does nothing until you set the repository variable
`APEX_KEEPALIVE_URL` to your server's address (Settings → Secrets and variables
→ Actions → Variables). Render's free tier allows 750 instance-hours a month
and a month is about 730 hours, so one permanently-awake service fits inside
the quota — though whether that is what the free tier is *for* is Render's call,
not mine, and unsetting the variable turns it off.

**Paid from student credit: Azure.** See below.

## The Student Pack, checked offer by offer

I checked these rather than trusting a list, and several widely-circulated ones
are out of date. Against the two things that matter here — **no card**, and
**can host a long-lived WebSocket process** — almost everything falls away:

| Offer | Card needed? | Usable for this server? |
|---|---|---|
| **Azure for Students** — $100, 12 months | **No** | **Yes** — the only offer that clears both bars |
| Heroku — $13/month credit | **Yes** | Would be ideal otherwise; the card rules it out |
| DigitalOcean — $200 | — | **Programme ended 1 August 2026**; credits expired |
| AWS Educate — $100 | No | No — a sandbox whose sessions expire after ~3 hours |
| Google Cloud — $300 + always-free e2-micro | **Yes** | The always-free VM would be perfect, but signup needs a card |
| Oracle Cloud — always-free VMs | **Yes** | Generous, and still needs a card for identity checks |
| IBM Cloud — Lite tier | Card hold | Serverless, scales to zero; ~100k vCPU-seconds a month is about 4% of always-on |
| Vercel / Netlify | No | No — serverless request handlers, not long-lived sockets |

Two corrections to the list you were looking at: **Heroku's "free Hobby Dyno"
no longer exists** — the offer is $13/month in credits and requires a card on
file, and **DigitalOcean's $200 student credit ended in August 2026.**

### Azure for Students — the always-on answer

$100 credit, 12 months, **no card at signup** — verified with your college
email, or a student ID upload if the email is not recognised. A student
subscription stops when the credit runs out rather than billing you, which is
exactly the behaviour you want.

Run the server on **Linux** App Service B1: roughly **$13/month**, so the credit
is about seven months of always-on multiplayer, with Always On available and a
350-concurrent-WebSocket limit — far more than a 20-car grid needs.

> The `--is-linux` flag below is load-bearing. The same B1 tier on Windows is
> about four times the price, which would turn seven months into under two.

```bash
# Once, with the Azure CLI installed and `az login` done.
az group create --name apex --location eastus

# Linux. See the note above.
az appservice plan create --name apex-plan --resource-group apex \
  --sku B1 --is-linux

az webapp create --resource-group apex --plan apex-plan \
  --name apex-circuit --runtime "NODE:20-lts"

# WebSockets are off by default, and the race server is nothing without them.
az webapp config set --resource-group apex --name apex-circuit \
  --web-sockets-enabled true --always-on true

az webapp config appsettings set --resource-group apex --name apex-circuit \
  --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true

az webapp deployment source config --resource-group apex --name apex-circuit \
  --repo-url https://github.com/<you>/car-racing-game \
  --branch main --manual-integration
```

Then point the Pages client at it exactly as with Render, using the
`APEX_SERVER_URL` variable.

Set a **billing alert** on the credit while you are in there. The subscription
stopping is the safe failure, but knowing it is close beats discovering it
stopped.

### If you would rather not spend the credit at all

Azure's **free F1 tier** costs nothing and now supports WebSockets — but only
**five concurrent connections**, with 60 CPU-minutes a day and no Always On. A
five-car race with friends would fit; a full grid would not, and it sleeps like
Render does. It is a real option, just a narrow one.

## Running it yourself

Nothing about the deployment is special; it is the same two commands you use
locally.

```bash
npm ci
npm run build      # produces dist/
npm start          # serves dist/ and the race server on PORT (default 8787)
```

`npm start` is the whole deployment: one process, both halves. Any host that
runs a Node process and allows WebSockets will do — which is the actual
requirement, and the reason the list of suitable free hosts is shorter than it
first appears.
