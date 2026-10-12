# Security and privacy

This file tells you what the WhatsApp Task Bot can access, where your data goes, and how the bot protects it. Read it before you install the bot.

## What the bot can do

The bot links to your WhatsApp account as a linked device, the same way as WhatsApp Web. With that link it can read your messages. The bot uses only the read functions. A guard in `src/guard.js` gives the rest of the code access only to the functions that do not send. Because of the guard, the bot cannot send a message, a reaction, a read receipt, or an "online" status.

Baileys, the library that connects to WhatsApp, is not an official WhatsApp client. WhatsApp can block accounts that use unofficial clients. The bot only reads, which decreases the risk, but the risk is not zero.

## Where your data goes

The language model operates on this computer, but that does not mean that all data stays here. Tasks go to Google Calendar, and the daily report goes through Gmail, if you set them up.

| Data | Where it goes |
|---|---|
| Message text | Only to this computer: the SQLite database and Ollama on `127.0.0.1`. |
| Task title, chat name, sender name, assignee, date | Google Calendar, in the calendar that you share with the service account. Only tasks for you, for the group, or with an unclear person, with a date. |
| Original message text | Not sent, by default. If you turn on "Put the original message in the calendar event" in Settings, the full message text goes to Google Calendar too. When you turn it off again, the bot rewrites the events that already exist. |
| Daily report | Your Gmail address, through Gmail: the chat summaries and the task list. |
| Log file | The `logs` folder. The log has no message text and no access token. |

The Ollama address must be on this computer (`127.0.0.1` or `localhost`). The bot does not start with a remote Ollama address. With a remote address, message text goes to another computer.

## How long the bot keeps data

| Data | Kept for | Setting |
|---|---|---|
| Message text | 48 hours | Settings, "Message text (hours)" |
| List of read message IDs | 7 days | Settings, "Processed message IDs (days)" |
| Chat summaries | Until the report of that day is saved, at most 7 days | None |
| Daily reports | 30 days | Settings, "Reports (days)" |
| Tasks | Until you delete them. A deleted task stays as a hidden row, so that the bot does not make it again from the same message. | None |
| Contact and group names | Until you delete the data folder | None |
| WhatsApp link keys | Until you unlink the bot | None |

The cleanup runs once a day after the report. If the computer was off, it runs after the next report. SQLite first writes changes to a WAL file (a write-ahead log, a file next to the database). The cleanup empties that file too, and it frees the space in the database file. A backup or a copy of the database that you made earlier keeps the old data.

To delete all local data, stop the bot, and delete the data folder (see "Secrets on disk"). To also stop the WhatsApp link, see "If the computer is lost or compromised".

The Ollama address must be on this computer (`127.0.0.1` or `localhost`). The bot does not start with a remote Ollama address. With a remote address, message text goes to another computer.

## Secrets on disk

A copy that you run from the source code keeps these files in the project folder. The installed app keeps them in `%LOCALAPPDATA%\WhatsApp Task Bot`, and an update of the app never changes that folder. These files contain secrets. Git ignores all of them, and you must never share or publish them:

1. `.env`: the Calendar ID, the Gmail address, and the Gmail App Password.
2. `keys\service-account.json`: the Google key. It gives write access to the calendars that you shared with the service account.
3. `data\`: the WhatsApp keys, the database, and the dashboard access token.
4. `config.json`: your name and settings.
5. The desktop shortcut: it contains the dashboard access link.

The dashboard never sends a secret back to the browser. It shows only "set" or "not set".

A program that operates under your own Windows user account can read these files. No local program can prevent that. Both folders are inside your user profile, so other Windows users on the computer cannot read them. Protect your Windows account with a password, and do not operate unknown programs.

## If the computer is lost or compromised

The WhatsApp link keys let a person read your new messages until you remove the link. Do these steps from your phone and from another computer:

1. On your phone, open WhatsApp, then "Linked devices". Select the bot's device and click "Log out". The keys in the data folder then stop working.
2. In Google Cloud, open the service account, then "Keys", and delete the key. Make a new key if you set up the bot again.
3. In your Google account, open "App passwords" and delete the bot's App Password.
4. If you can still use the computer, delete the data folder and the `.env` file.

## Untrusted input

The bot treats every WhatsApp message as untrusted input.

1. The prompt tells the language model that messages are data, not instructions. A message that tells the model to ignore its rules gives no special result.
2. The model output is not trusted either. The bot accepts only the expected fields, with the correct types and maximum lengths. It removes control characters and text direction characters. Invalid JSON, invalid dates, and unknown values are refused or replaced with safe values. A part of a chat that gives invalid output is split and tried again, and a single message that still fails is skipped and logged without its text.
3. The model output cannot start an action. It only fills database rows. The calendar and the email use fixed code paths.
4. The dashboard and the report escape all text from messages and from the model before they show it as HTML.
5. Uncertain tasks (an unclear person, low confidence, or a date that the model guessed) get a "Needs review" warning on the dashboard and in the report, and a "?" in the calendar event.

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

The bot operates as one Node process. It starts other processes only for these fixed actions, and the page cannot give arguments to them:

1. "Start the bot with Windows" in the setup: PowerShell with the script `scripts\install-autostart.ps1`.
2. "Install Ollama" in the setup: `winget install --id Ollama.Ollama`, then the Ollama app.
3. "Put a shortcut on the desktop" in the installed app: PowerShell with the script `scripts\make-shortcut.ps1`.

## Continuous integration

The GitHub workflows use the actions at fixed commit hashes, not at tags that can move. The release workflow gets only the permission to write releases. It uses no other secrets.

## Report a problem

If you find a security problem, do not open a public issue. Contact the owner of the repository privately through GitHub.
