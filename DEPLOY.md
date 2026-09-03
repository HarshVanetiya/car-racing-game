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

### What the free tier costs you

A free Render service **sleeps after 15 minutes with no traffic** and takes
30–60 seconds to wake. For multiplayer that means the first person to open the
lobby waits; everyone after them does not. It is fine for testing and for
playing with friends, and it is the reason to keep the client on Pages: the
game itself always loads instantly.

---

## What about the Student Pack?

You do not need it for any of the above, and that is deliberate — spending a
one-off credit on something two free tiers already do is a waste of the credit.

Keep it for the problem the free tier actually has: **the server sleeping.**
When you want an always-on server with no cold start, the pack's best fit is:

**Azure for Students — $100 credit, no card at signup**, verified with your
college email or student ID. An App Service on the B1 plan (~$13/month) runs
this server continuously and supports WebSockets, so the credit is roughly
seven months of always-on multiplayer.

```bash
# Once, with the Azure CLI installed and `az login` done:
az group create --name apex --location eastus
az appservice plan create --name apex-plan --resource-group apex --sku B1 --is-linux
az webapp create --resource-group apex --plan apex-plan --name apex-circuit \
  --runtime "NODE:20-lts"
az webapp config set --resource-group apex --name apex-circuit --web-sockets-enabled true
az webapp config appsettings set --resource-group apex --name apex-circuit \
  --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true
az webapp deployment source config --resource-group apex --name apex-circuit \
  --repo-url https://github.com/<you>/car-racing-game --branch main --manual-integration
```

Set **billing alerts** on the credit before you do this. A student subscription
stops rather than bills you when the credit runs out, which is the behaviour you
want, but knowing it is running low is better than discovering it stopped.

Other pack entries are a worse fit here, for reasons worth knowing:

- **DigitalOcean ($200)** — genuinely good hosting, but verification normally
  wants a card or PayPal even when the credit covers the bill.
- **Heroku** — no free tier any more; the student offer is credits, same trade
  as Azure but with less of them.
- **AWS Educate / Free Tier** — the standard AWS free tier asks for a card at
  signup. AWS Educate avoids that but does not give you a normal account you can
  deploy a Node server to.

---

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
