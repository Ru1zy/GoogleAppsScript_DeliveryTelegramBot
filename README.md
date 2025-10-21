# Food Delivery Telegram Bot (Google Apps Script)

## 🇬🇧 English

### Overview

**Food Delivery Telegram Bot** is a Telegram bot built with **Google Apps Script (GAS)** to automate delivery management using **Google Sheets** as a database.
The bot handles customer registration, binds phone numbers to Telegram chat IDs, sends personalized and general notifications, logs activity, and supports admin commands.
It works directly through a GAS Web App URL, optionally proxied via services like Hookdeck.

---

### Features

* 🔄 Automatic phone number normalization and chat ID binding
* 💬 Individual and general note delivery
* 🧾 Logging of sent messages
* ⚙️ Admin commands: force bind, unbind, preview, and dump chat IDs
* 🌐 Runs entirely in Google Apps Script
* 📋 Google Sheets used as both database and UI

---

### Setup Guide

#### 1. Create Google Sheets

Create a spreadsheet with these sheets:

**Sheet: Info**
| Name | Phone | Address | Chat ID |

**Sheet: Today**
| Name | Phone | Address | Chat ID | Delivery Time | Personal Notes | General Notes (H2 only) |

**Sheet: Logs**
| Date | Message | Status |

---

#### 2. Create a Telegram Bot

1. Open [@BotFather](https://t.me/BotFather)
2. Use `/newbot` to create your bot
3. Save the **bot token**

---

#### 3. Deploy Google Apps Script

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Paste the bot code
3. Replace constants:

```js
const TOKEN = 'your_telegram_token';
const SHEET_ID = 'your_google_sheet_id';
const TEST_CHAT_ID = your_chat_id;
```

4. Deploy as **Web App** (accessible to “Anyone, even anonymous”)
   Copy the generated Web App URL (e.g., `https://script.google.com/macros/s/.../exec`) — this acts as your webhook endpoint.

---

#### 4. Connect Telegram Webhook

Set the webhook to your Web App URL:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_WEB_APP_URL>
```

Optional: use Hookdeck or another proxy for stable webhook delivery.

---

### Usage

* `/start` → Register or check your account
* `/forcebind <phone> <chatId>` → Admin: forcibly bind number to chat
* `/unbind <phone>` → Admin: unbind chat
* `/dump` → Admin: show phone → chat ID mapping
* In-chat buttons allow users to change their phone numbers
* UI menu in Google Sheets allows sending today’s delivery times, personal notes, general notes, or all combined, as well as test messages and previews

---

### Tech Stack

* **Google Apps Script** — backend logic
* **Telegram Bot API** — communication
* **Google Sheets** — database and admin interface

---

## 🇺🇦 Українська

### Опис

**Food Delivery Telegram Bot** — Telegram-бот на **Google Apps Script (GAS)** для автоматизації доставки через **Google Sheets**.
Бот реєструє користувачів, прив’язує номери телефонів до Telegram chat ID, надсилає персональні та загальні повідомлення, веде журнал активності та підтримує адмін-команди.
Працює безпосередньо через URL Web App GAS, за потреби можна проксирувати через Hookdeck (TG API не дуже коректно сприймає повільні відповіді від GAS і може кидати помилки, тому Hookdeck швидко підтверджує отримання вебхука і передає дані скрипту).

---

### Основні можливості

* 🔄 Нормалізація номерів і прив’язка chat ID
* 💬 Надсилання персональних і загальних нотаток
* 🧾 Ведення журналу відправлень
* ⚙️ Адмін-команди: force bind, unbind, preview, dump chat IDs
* 🌐 Повністю працює у Google Apps Script
* 📋 Google Sheets як база даних та UI

---

### Інструкція з налаштування

#### 1. Створіть Google Sheets

Створіть аркуші:

**Аркуш: Info**
| ПІБ | Телефон | Адреса | Chat ID |
<img width="869" height="217" alt="image" src="https://github.com/user-attachments/assets/4a2282fd-dc52-478f-a0f8-9ca088993fce" />

**Аркуш: Today**
| ПІБ | Телефон | Адреса | Chat ID | Час доставки | Персональні нотатки | Загальні нотатки (лише H2) |
<img width="1280" height="243" alt="image" src="https://github.com/user-attachments/assets/0ba57f2f-947a-4ce2-8b45-c361e1bfea47" />

**Аркуш: Logs**
Стовпці за бажанням (можна без них):
| Дата | Повідомлення | Статус |

---

#### 2. Створіть Telegram-бота

1. Відкрийте [@BotFather](https://t.me/BotFather)
2. Використайте `/newbot`
3. Збережіть **токен** бота

---

#### 3. Розгорніть Google Apps Script

1. У Google Sheet оберіть **Розширення → Apps Script**
2. Вставте код бота
3. Замініть константи:

```js
const TOKEN = 'ваш_токен_бота';
const SHEET_ID = 'ID_вашої_таблиці';
const TEST_CHAT_ID = ваш_chat_id;
```

4. Опублікуйте як **Web App** (доступ “Для всіх, навіть анонімних”)
   Скопіюйте URL Web App (`https://script.google.com/macros/s/.../exec`) — це ваш webhook.

---

#### 4. Підключення вебхука Telegram

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_WEB_APP_URL>
```

За потреби можна використовувати Hookdeck для стабільності доставки вебхуків.

---

### Використання

* `/start` → реєстрація або перевірка акаунту
* `/forcebind <phone> <chatId>` → адмін: примусово прив’язати номер до чату
* `/unbind <phone>` → адмін: відв’язати чат
* `/dump` → адмін: показати відображення телефон → chat ID
* Кнопки в чаті дозволяють користувачу змінювати номер телефону
* Меню Google Sheets: надсилання часу доставки, персональних нотаток, загальних, все разом, тестові повідомлення, попередній перегляд

---

### Технології

* **Google Apps Script** — серверна логіка
* **Telegram Bot API** — інтеграція з Telegram
* **Google Sheets** — база даних і адмінський інтерфейс
