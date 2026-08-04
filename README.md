<div align="center">

### ⚡ SYSTEM TERMINAL & LIVE LOGS ⚡

<table>
<tr>
<td bgcolor="#050801" width="100%">

<pre>
<font color="#00FF66"><b>
   ██████╗ ██╗██╗     ███████╗███╗   ██╗████████╗    ██████╗ ██████╗ ████████╗
   ██╔════╝██║██║     ██╔════╝████╗  ██║╚══██╔══╝    ██╔══██╗██╔══██╗╚══██╔══╝
   ███████╗██║██║     █████╗  ██╔██╗ ██║   ██║       ██████╔╝██║  ██║   ██║   
   ╚════██║██║██║     ██╔══╝  ██║╚██╗██║   ██║       ██╔══██╗██║  ██║   ██║   
   ███████║██║███████╗███████╗██║ ╚████║   ██║       ██████╔╝██████╔╝   ██║   
   ╚══════╝╚═╝╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝       ╚═════╝ ╚═════╝    ╚═╝   
</b></font>
<font color="#00FF66">===================================================================================</font>
<font color="#00FF66"><b>[SYSTEM STATUS]</b></font> <font color="#00FF00">● ONLINE</font>  |  <font color="#00FF66"><b>[PROCESS]</b></font> <font color="#00FF00">PID 8042 (pm2: silent-status)</font>
<font color="#00FF66"><b>[CORE MEMORY]</b></font>   <font color="#00FF00">28.4 MB / 1024 MB</font>  |  <font color="#00FF66"><b>[ARCH]</b></font> <font color="#00FF00">Ubuntu 22.04 LTS (x86_64)</font>
<font color="#00FF66"><b>[AUTHOR/SUDO]</b></font>   <font color="#00FF00">root@josva-vps:~#</font>
<font color="#00FF66">===================================================================================</font>

<font color="#008000">14:02:01 [SYS_INIT] Loading Baileys WebSocket protocol engine...</font>
<font color="#00FF00">14:02:03 [NET_CONN] Authentic connection established with WhatsApp Servers [OK]</font>
<font color="#00FF00">14:02:03 [SUDO_DM]  Startup payload dispatched to owner terminal.</font>

<font color="#00FF66"><b>root@josva-vps:~#</b></font> <font color="#00FF00">tail -f /var/log/silent-status.log</font>

<font color="#33FF33">14:05:12 [STATUS_SWEEP] Intercepted 14 contact status updates.</font>
<font color="#33FF33">14:05:12 [QUEUE_PROC]  Executing non-blocking receipt pipeline (50ms offset)...</font>
<font color="#00FF00">14:05:13 [SUCCESS]     100% status views acknowledged silently [NO_MEDIA_DOWNLOADED].</font>

<font color="#FF3333">14:12:44 [EVENT_REVOKE] Deleted message detected in group [40912-US].</font>
<font color="#00FF66">14:12:44 [ANTI_DELETE] Buffer restored: [TEXT/IMAGE] -> Rerouting payload to SUDO DM.</font>
<font color="#00FF00">14:12:45 [SUCCESS]     Target media extracted & pushed successfully.</font>

<font color="#00FF66"><b>root@josva-vps:~#</b></font> <font color="#00FF00">_</font>
</pre>

</td>
</tr>
</table>

</div>





# Silent Status & Anti-Delete WhatsApp Bot

A lightweight, high-performance WhatsApp utility bot **designed by Josva**.

This bot is specifically optimized for VPS deployment (under 30 MB RAM footprint). It automatically views WhatsApp statuses silently without spamming your private chat with downloaded media, restores deleted messages, unlocks View-Once media, and provides in-chat command management.

---

## Key Features

* **👀 Silent Auto Status Viewer (`no-dl`):** Automatically sends view receipts for 100% of contact statuses without forwarding media or photos to your chat.
* **⚡ Non-Blocking Status Queue:** Includes a 50ms queue handler and 5-minute background sweeper so multi-slide status bursts are never skipped.
* **🗑️ Anti-Delete (`.delete p` / `.delete g`):** Captures deleted text, images, videos, stickers, and voice notes. Forwards deleted media privately to your SUDO DM or back to the same group.
* **🔓 View-Once Unlocker (`.vv`):** Reply `.vv` to any View-Once photo, video, or voice message to unlock and resend it silently in chat.
* **💾 Content Saver (`.save`):** Reply `.save` to any text or media to save a copy directly to your private SUDO DM.
* **⚙️ Dynamic In-Chat Commands:** Control and toggle all bot settings via WhatsApp chat without logging into your VPS.
* **🚀 VPS Optimized:** Uses under 30 MB RAM, runs cleanly on 1 GB RAM VPS servers.
* **🔔 Startup Notification:** Sends an automated notification to your WhatsApp DM upon launch, detailing active settings and available commands.

---

## In-Chat Commands (SUDO / Owner Only)

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`.status`** | `.status no-dl` / `.status off` | Toggles status auto-viewing mode. |
| **`.delete`** | `.delete p` / `.delete g` / `.delete off` | Toggles Anti-Delete mode (Private DM, Group, or Off). |
| **`.viewall`** | `.viewall` | Manually sweeps and re-views all active 24h status updates. |
| **`.vv`** | Reply `.vv` to View-Once media | Unlocks and resends View-Once media in chat silently. |
| **`.save`** | Reply `.save` to any media/text | Saves a copy directly to your private SUDO DM. |
| **`.settings`** | `.settings` / `.menu` / `.vars` | Displays live bot configuration, RAM usage, and uptime. |

---

## VPS Deployment Guide (Step-by-Step)

### Prerequisites

* VPS running **Ubuntu 20.04 / 22.04 / 24.04 LTS**
* SSH terminal access
* Node.js v18+ and NPM installed

---

### Step 1: Install Node.js & PM2 on VPS

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL [https://deb.nodesource.com/setup_20.x](https://deb.nodesource.com/setup_20.x) | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### Step 2: Clone Repository & Install Dependencies

```bash
git clone [https://github.com/josva12/silent-status-bot.git](https://github.com/josva12/silent-status-bot.git)
cd silent-status-bot
npm install
```

### Step 3: Link WhatsApp Account (QR Code Scan)
Run the bot once in interactive mode to scan the QR code:

```bash
npm start
```

1. Open WhatsApp on your phone.

2. Tap Settings → Linked Devices → Link a Device.

3. Scan the QR code displayed in your VPS terminal.

4. Once you see ✅ Connected! Silent Status Bot Active!, press Ctrl + C to stop the interactive session.

### Step 4: Run 24/7 with PM2

Start the bot as a background service:

```bash
pm2 start index.js --name silent-status
pm2 save
pm2 startup
```

### Step 5: Useful Management Commands

| Action | Command |
| :--- | :--- |
| **View Live Logs** | `pm2 logs silent-status` |
| **Restart Bot** | `pm2 restart silent-status --update-env` |
| **Check Status** | `pm2 status` |
| **Stop Bot** | `pm2 stop silent-status` |

---

## Dependencies Used

* `@whiskeysockets/baileys` — WhatsApp Web WebSocket Library
* `qrcode-terminal` — Terminal QR Code Renderer
* `pino` — Fast, low-overhead Node.js Logger

---

## Credits & Author

* **Designed & Developed by:** Josva ([josva12](https://github.com/josva12))
* **License:** MIT






