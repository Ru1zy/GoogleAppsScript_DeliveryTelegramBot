# Food Delivery & Meal Plan Telegram Bot (GAS)

## 🇬🇧 English

### Overview
Automated system for managing meal delivery and customized nutrition plans. Built with **Google Apps Script (GAS)** and **Telegram Bot API**. Uses Google Sheets as a database and admin interface.

---

### Features
* **Dynamic Meal Selection**: Logic automatically adjusts steps based on package (Slim: 3, Balance: 4, Sport Active+: 5 meals).
* **Sushka Bypass**: Automatic fixed-menu assignment for "Sushka (food dehydration?) XS/S" packages (skips manual dish selection).
* **Linear Selection Flow**: Guided sequence (Breakfast → Lunch → Dinner → Snacks) to prevent logic errors.
* **Delivery Management**: Users can update delivery address and time via the `/delivery` menu.
* **Admin Tools**: Commands for manual chat ID binding (`/forcebind`), unbinding, and database dumps.

---

### Setup Guide

#### 1. Create Google Sheets
Create a spreadsheet with these exact sheet names:
* **Info**: Client database (Name, Phone, Address, Chat ID, Time, Notes (all/single), Package Name, Dishes, Cutlery (count), 
Nutritional features).
* **Menu**: Daily options. Columns: `Date`, `Photo ID`, `Breakfast (x2)`, `Lunch (x2)`, `Dinner (x2)`, `Snack 1`, `Snack 2`, `Package Name (L)`,`Photo ID (to package name)`.
* **Orders**: Selection logs and payment status.
* **Logs**: System activity.

#### 2. Configuration
In Apps Script **Project Settings > Script Properties**, add:
* `TG_TOKEN`: Telegram bot token.
* `SHEET_ID`: Main spreadsheet ID.
* `EXTERNAL_SHEET_ID`: Accounting spreadsheet ID.
* `TEST_CHAT_ID`: Admin Telegram ID.

#### 3. Deployment
1. Go to **Deploy > New Deployment**.
2. Select **Web App**.
3. Execute as: **Me**.
4. Access: **Anyone**.
5. Set Webhook: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WEBAPP_URL>`

---

## 🇺🇦 Українська

### Опис
Автоматизована система управління доставкою їжі та раціонами на базі **Google Apps Script**. Використовує Google Sheets як базу даних та інтерфейс управління.

---

### Основні можливості
* **Динамічний вибір**: Кількість етапів вибору адаптується під пакет (3, 4 або 5 прийомів їжі).
* **Байпас "Сушки"**: Автоматичне призначення фіксованого меню для пакетів XS/S без ручного вибору страв.
* **Лінійна логіка**: Послідовний вибір категорій страв для уникнення помилок.
* **Управління доставкою**: Можливість зміни адреси та часу доставки через інтерфейс бота.
* **Адмін-панель**: Команди для керування базою користувачів та розсилок.

---

### Налаштування

#### 1. Структура таблиць
Створіть аркуші:
* **Info**: ПІБ, Телефон, Адреса, Chat ID, Час.
* **Menu**: Щоденне меню. Назва пакета в стовпці **L** має збігатися з кнопками в боті.
* **Orders**: Журнал замовлень, пакетів та обраних страв.

#### 2. Властивості скрипта
В налаштуваннях проекту Apps Script додайте **Script Properties**:
* `TG_TOKEN`: Токен бота.
* `SHEET_ID`: ID поточної таблиці.
* `EXTERNAL_SHEET_ID`: ID зовнішньої таблиці обліку.
* `TEST_CHAT_ID`: Ваш Telegram ID.

#### 3. Розгортання
1. Опублікуйте як **Web App** (Доступ: "Anyone").
2. Встановіть вебхук через браузер: 
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL_ВЕБ_ДОДАТКУ>`

---

### Tech Stack
* **Google Apps Script**
* **Telegram Bot API**
* **Google Sheets**
