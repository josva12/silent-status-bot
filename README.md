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
