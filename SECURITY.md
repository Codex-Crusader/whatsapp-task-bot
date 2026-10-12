# Security and privacy

This file tells you what the WhatsApp Task Bot can access, where your data goes, and how the bot protects it. Read it before you install the bot.

## What the bot can do

The bot links to your WhatsApp account as a linked device, the same way as WhatsApp Web. With that link it can read your messages. The bot uses only the read functions. A guard in `src/guard.js` gives the rest of the code access only to the functions that do not send. Because of the guard, the bot cannot send a message, a reaction, a read receipt, or an "online" status.

Baileys, the library that connects to WhatsApp, is not an official WhatsApp client. WhatsApp can block accounts that use unofficial clients. The bot only reads, which decreases the risk, but the risk is not zero.

## Where your data goes

| Data | Where it goes |
|---|---|
| Message text | Only to this computer: the SQLite file in `data\` and Ollama on `127.0.0.1`. The bot keeps message text for 48 hours. |
| Task title, chat name, sender name, original message | Google Calendar, in the calendar that you share with the service account. You can turn off the original message in Settings. |
| Daily report | Your Gmail address, through Gmail. |
| Log file | `logs\`. The log has no message text. |

The Ollama address must be on this computer (`127.0.0.1` or `localhost`). The bot does not start with a remote Ollama address. With a remote address, message text goes to another computer.

## Secrets on disk

These files contain secrets. Git ignores all of them, and you must never share or publish them:

1. `.env`: the Calendar ID, the Gmail address, and the Gmail App Password.
2. `keys\service-account.json`: the Google key. It gives write access to the calendars that you shared with the service account.
3. `data\`: the WhatsApp keys, the database, and the dashboard access token.
4. `config.json`: your name and settings.
5. The desktop shortcut: it contains the dashboard access link.

The dashboard never sends a secret back to the browser. It shows only "set" or "not set".

A program that operates under your own Windows user account can read these files. No local program can prevent that. Protect your Windows account with a password, and do not operate unknown programs.

## The dashboard

The dashboard listens only on `127.0.0.1`, so other computers cannot connect to it. These protections apply on this computer:

1. Access token. Every page and every change needs a random 256-bit token. The desktop shortcut and `npm run dashboard-url` give the link. The `/login` page puts the token in a cookie (`HttpOnly`, `SameSite=Strict`) and removes it from the address bar. Without the token, a page shows only how to get the link.
2. Host check. The dashboard answers only to `localhost:<port>` and `127.0.0.1:<port>`. This stops DNS rebinding (a trick that makes a website reach a local server).
3. Change protection. A change (task edit, setup step) must come from the dashboard page itself: the request needs the dashboard origin, a JSON body, and a custom header. A website in another tab cannot make such a request.
4. Strict Content Security Policy. A dashboard page runs only the dashboard's own scripts. A saved report runs no script at all, so text from a WhatsApp message cannot run as code.
5. Input checks. The dashboard checks each value (names, dates, email addresses, the key file) before it saves it. A value with a line break cannot get into `.env`.

## Dependencies

The file `.npmrc` turns off the install scripts of all dependencies (`ignore-scripts=true`). A compromised package often attacks at install time, with such a script. The bot does not need these scripts: `better-sqlite3` includes ready binaries, and the other scripts only check versions. `package-lock.json` fixes the exact version and checksum of each package.

## Child processes

The bot operates as one Node process. It starts one other process only when you click "Start the bot with Windows" in the setup: PowerShell with the fixed script `scripts\install-autostart.ps1`. The page cannot give arguments to that script.

## Report a problem

If you find a security problem, do not open a public issue. Contact the owner of the repository privately.
