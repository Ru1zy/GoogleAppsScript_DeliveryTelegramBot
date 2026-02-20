// --- Константы ---
var PROPS = PropertiesService.getScriptProperties();
var TOKEN = PROPS.getProperty('TG_TOKEN');
var SHEET_ID = PROPS.getProperty('SHEET_ID');
var EXTERNAL_SHEET_ID = PROPS.getProperty('EXTERNAL_SHEET_ID');
var TEST_CHAT_ID = parseInt(PROPS.getProperty('TEST_CHAT_ID'), 10);

var CLIENTS_SHEET = "Info";
var TODAY_SHEET = "Today";
var LOGS_SHEET = "Logs";

var MENU_SHEET = "Menu";
var ORDERS_SHEET = "Orders";

// Колонки (1-based для удобства, в коде используем -1 при индексировании массивов)
var PHONE_COL = 3;          // C
var CHAT_COL = 5;           // E
var NOTE_COL = 7;           // G
var GENERAL_NOTE_COL = 8;   // H (общая заметка — только в H2)
var DELIVERY_TIME_COL = 6;  // F

// Админы
var ADMIN_CHAT_IDS = [TEST_CHAT_ID];

// --- Нормализация номера ---
function normalizePhone(phone) {
  if (!phone && phone !== 0) return "";
  phone = phone.toString().replace(/\D/g,'');
  if (phone.length === 9) phone = "0" + phone;
  if (phone.length === 12 && phone.startsWith("380")) phone = "0" + phone.slice(3);
  if (phone.length === 10 && phone.startsWith("0")) return phone;
  return "";
}

function isValidUAphone(phone) {
  const validPrefixes = ["039","050","063","066","067","068","091","092","093","094",
                         "095","096","097","098","099","073","089"];
  if (!phone) return false;
  phone = normalizePhone(phone);
  if (!/^0\d{9}$/.test(phone)) return false;
  return validPrefixes.indexOf(phone.substr(0,3)) !== -1;
}

// --- Логирование ---
function logEvent() {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(LOGS_SHEET);
    var row = [new Date()].concat(Array.prototype.slice.call(arguments));
    sheet.appendRow(row);
  } catch(e) {}
}

// --- fetch с retry ---
function fetchWithRetry(url, options, attempts) {
  attempts = attempts || 3;
  var wait = 500;
  for (var i=0;i<attempts;i++){
    try {
      return UrlFetchApp.fetch(url, options);
    } catch(e) {
      Utilities.sleep(wait);
      wait *= 2;
      if (i === attempts-1) throw e;
    }
  }
}

// --- Telegram ---
function sendTelegramMessage(chatId, message, inlineKeyboard) {
  try {
    var payload = { chat_id: chatId, text: message || "Сообщение", parse_mode: "HTML", reply_markup: {} };
    if (inlineKeyboard && inlineKeyboard.length) {
      payload.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard, remove_keyboard: true });
    } else {
      payload.reply_markup = JSON.stringify({ remove_keyboard: true });
    }
    var options = { method: "post", contentType: "application/json", payload: JSON.stringify(payload) };
    var response = fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/sendMessage", options);
    logEvent('sendTelegramMessage', chatId, 'resp', response.getContentText());
  } catch(e) {
    logEvent('sendTelegramMessage error', e.toString());
  }
}

function sendTelegramPhoto(chatId, fileId, caption, inlineKeyboard) {
  try {
    var payload = { 
      chat_id: chatId, 
      photo: fileId, 
      caption: caption || "", 
      parse_mode: "HTML" 
    };
    if (inlineKeyboard && inlineKeyboard.length) {
      payload.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
    }
    var options = { method: "post", contentType: "application/json", payload: JSON.stringify(payload) };
    fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/sendPhoto", options);
  } catch(e) {
    logEvent('sendTelegramPhoto error', e.toString());
  }
}

// --- Получить chatId из Info по номеру ---
function getChatFromInfoByPhone(phone, clientsData) {
  if (!phone) return "";
  var norm = normalizePhone(phone);
  for (var i = 1; i < clientsData.length; i++) {
    var rowPhone = normalizePhone(clientsData[i][PHONE_COL-1]);
    var rowChat = (clientsData[i][CHAT_COL-1] || "").toString().trim();
    if (rowPhone === norm && rowChat) return rowChat;
  }
  return "";
}

// --- Привязка chatId (bind) ---
function bindChatId(phone, chatId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(CLIENTS_SHEET);
    var data = sheet.getDataRange().getValues();
    var normalized = normalizePhone(phone);

    logEvent('bindChatId start', phone, '->', normalized, 'chatId', chatId);

    if (!isValidUAphone(normalized)) {
      logEvent('bindChatId invalid phone', normalized);
      return "invalid";
    }

    var oldIndexes = [], targetIndexes = [];
    for (var i = 1; i < data.length; i++) {
      var rowPhone = normalizePhone(data[i][PHONE_COL-1]);
      var rowChat = data[i][CHAT_COL-1];
      if (rowChat == chatId) oldIndexes.push(i);
      if (rowPhone === normalized) targetIndexes.push(i);
    }

    if (targetIndexes.length === 0) {
      logEvent('bindChatId not_found', normalized);
      return "not_found";
    }

    for (var t of targetIndexes) {
      var existingChat = data[t][CHAT_COL-1];
      if (existingChat && existingChat != chatId) {
        logEvent('bindChatId conflict existingChat', existingChat, 'at row', t+1);
        return "already";
      }
    }

    // Очистка старых chatId
    for (var oi of oldIndexes) {
      if (targetIndexes.indexOf(oi) === -1) {
        data[oi][CHAT_COL-1] = "";
        logEvent('cleared old chatId at row', oi+1);
      }
    }

    // Проставляем chatId всем строкам targetIndexes
    for (var ti of targetIndexes) data[ti][CHAT_COL-1] = chatId;

    // batch set
    sheet.getRange(2, CHAT_COL, data.length-1, 1).setValues(data.slice(1).map(r=>[r[CHAT_COL-1]]));

    logEvent('bindChatId OK for', normalized, 'rows', JSON.stringify(targetIndexes));
    return "ok";
  } finally {
    lock.releaseLock();
  }
}

// --- Управление статусами ---
function setUserStatus(chatId, status) {
  var props = PropertiesService.getDocumentProperties();
  if (status && status !== '') props.setProperty('status_' + chatId, status);
  else props.deleteProperty('status_' + chatId);
  logEvent('setUserStatus', chatId, status || '(cleared)');
}
function getUserStatus(chatId) { return PropertiesService.getDocumentProperties().getProperty('status_' + chatId) || ''; }
function clearUserStatus(chatId) { setUserStatus(chatId, ''); }

// --- Обработка ввода номера (UI в чате) ---
function handlePhoneInput(chatId, text) {
  var phone = normalizePhone(text);
  
  // Оновлені кнопки для успішної прив'язки
  var inlineKeyboard_ok = [
    [{ text: "🛒 Зробити замовлення", callback_data: "new_order" }],
    [{ text: "📋 Мої замовлення", callback_data: "my_orders" }],
    [{ text: "⚙️ Змінити номер", callback_data: "change_yes" }]
  ];
  
  var inlineKeyboard_again = [[{ text: "Ввести інший номер", callback_data: "change_yes" }]];

  var bindResult = bindChatId(phone, chatId);
  switch(bindResult) {
    case "ok": 
      sendTelegramMessage(chatId, `✅ Ваш чат успішно прив'язано до номера: ${phone}`, inlineKeyboard_ok); 
      break;
    case "already": 
      sendTelegramMessage(chatId,"❌ Цей номер вже прив'язаний до іншого акаунту.", inlineKeyboard_again); 
      break;
    case "not_found": 
      sendTelegramMessage(chatId,"❌ Вас немає у списку клієнтів. Перевірте номер або зверніться до адміністратора.", inlineKeyboard_again); 
      break;
    default: 
      sendTelegramMessage(chatId,"❌ Невірний номер. Спробуйте формат 0XXXXXXXXX", inlineKeyboard_again); 
      break;
  }

  clearUserStatus(chatId);
}

function getDraft(chatId) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("draft_" + chatId);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch(e) {
      return null;
    }
  }
  return null;
}

function saveDraft(chatId, draftObj) {
  var cache = CacheService.getScriptCache();
  cache.put("draft_" + chatId, JSON.stringify(draftObj), 21600);
}

function deleteDraft(chatId) {
  var cache = CacheService.getScriptCache();
  cache.remove("draft_" + chatId);
}

function showMainMenu(chatId, text) {
  var menu = [
    [{ text: "🛒 Зробити замовлення", callback_data: "new_order" }],
    [{ text: "📋 Мої замовлення", callback_data: "my_orders" }],
    [{ text: "⚙️ Змінити номер", callback_data: "change_yes" }]
  ];
  sendTelegramMessage(chatId, text || "Ось ваше головне меню:", menu);
}

// --- Логика заказа: Шаг 1 (Выбор пакета) ---
function handleNewOrder(chatId, messageIdToEdit) {
  var keyboard = [
    [{ text: "🥗 Slim [1200-1300 ккал]", callback_data: "view_package_Slim" }],
    [{ text: "🍲 Balance [1500-1600 ккал]", callback_data: "view_package_Balance" }],
    [{ text: "💪 Active [1800-2000 ккал]", callback_data: "view_package_Active" }],
    [{ text: "⚡️ Sport Active+ [2200-2400 ккал]", callback_data: "view_package_Sport Active+" }],
    [{ text: "🔥 Сушка (Фіксоване меню) ⬇️", callback_data: "submenu_sushka" }]
  ];
  var text = "🍽 Оберіть ваш тарифний план для перегляду деталей:";
  
  if (messageIdToEdit) {
    editTextMessage(chatId, messageIdToEdit, text, keyboard);
  } else {
    sendTelegramMessage(chatId, text, keyboard);
  }
}

function showPackageDetails(chatId, packageName, messageIdToEdit) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var menuSheet = ss.getSheetByName(MENU_SHEET);
  // Читаем диапазон L2:M7 (где L - названия, M - ID фото)
  var pkgData = menuSheet.getRange("L2:M7").getValues();
  
  var photoId = "";
  for (var i = 0; i < pkgData.length; i++) {
    if (String(pkgData[i][0]).trim() === packageName) {
      photoId = pkgData[i][1];
      break;
    }
  }

  // Удаляем текстовое меню
  if (messageIdToEdit) {
    try {
      fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", {
        method: "post", contentType: "application/json",
        payload: JSON.stringify({ chat_id: chatId, message_id: messageIdToEdit })
      });
    } catch(e) {}
  }

  var caption = "<b>Програма: " + packageName + "</b>\n\nБажаєте замовити цей пакет?";
  var keyboard = [
    [{ text: "✅ Так, обрати цей пакет", callback_data: "set_package_" + packageName }],
    [{ text: "🔙 Назад до вибору", callback_data: "new_order_edit_photo" }]
  ];

  if (photoId) {
    sendTelegramPhoto(chatId, photoId, caption, keyboard);
  } else {
    // Фолбэк, если в таблице нет ID фото
    sendTelegramMessage(chatId, caption + "\n\n<i>(Фото не знайдено в таблиці)</i>", keyboard);
  }
}

// --- Логика заказа: Шаг 2 (Выбор недели) ---
function askWeekSelection(chatId, selectedPackage) {
  // 1. Создаем/Обновляем черновик с выбранным пакетом
  var draft = getDraft(chatId) || {};
  draft.package = selectedPackage;
  draft.step = "week_selection";
  draft.orders = draft.orders || {}; 
  
  saveDraft(chatId, draft);

  // 2. Рассчитываем даты
  var today = new Date();
  var currentMonday = getMonday(today);
  var nextMonday = new Date(currentMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  var currEnd = new Date(currentMonday); currEnd.setDate(currEnd.getDate()+6);
  var nextEnd = new Date(nextMonday); nextEnd.setDate(nextEnd.getDate()+6);

  var btnCurrent = `Поточний тиждень (${formatDate(currentMonday)} - ${formatDate(currEnd)})`;
  var btnNext = `Наступний тиждень (${formatDate(nextMonday)} - ${formatDate(nextEnd)})`;

  var keyboard = [
    [{ text: btnCurrent, callback_data: "set_week_" + toIsoDate(currentMonday) }],
    [{ text: btnNext, callback_data: "set_week_" + toIsoDate(nextMonday) }],
  ];
  keyboard.push([{ text: "❌ Скасувати замовлення", callback_data: "cancel_order" }]);
  
  sendTelegramMessage(chatId, `Тариф: <b>${selectedPackage}</b> ✅\nОберіть тиждень доставки:`, keyboard);
}

// --- Логика заказа: Шаг 3 (Мультивыбор дней с проверкой времени) ---
function askDaySelection(chatId, messageIdToEdit) {
  var draft = getDraft(chatId);
  if (!draft || !draft.weekStart) {
    sendTelegramMessage(chatId, "⚠️ Помилка сесії. Почніть заново: /start");
    return;
  }

  var weekStart = new Date(draft.weekStart);
  var selectedDays = draft.selectedDays || []; 
  var daysNames = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
  
  var timeZone = Session.getScriptTimeZone();
  var now = new Date();
  var currentHour = parseInt(Utilities.formatDate(now, timeZone, "HH"), 10);
  var todayStr = Utilities.formatDate(now, timeZone, "yyyy-MM-dd");
  var todayDate = new Date(todayStr); // Сегодня 00:00:00

  var keyboard = [];
  
  for (var i = 0; i < 7; i++) {
    var d = new Date(weekStart);
    d.setDate(d.getDate() + i); 
    
    var dStr = Utilities.formatDate(d, timeZone, "yyyy-MM-dd");
    var checkDate = new Date(dStr);

    // --- ЛОГИКА ДЕДЛАЙНА (2 дня до 14:00) ---
    var diffTime = checkDate.getTime() - todayDate.getTime();
    var diffDays = Math.round(diffTime / (1000 * 3600 * 24));
    
    var isAllowed = false;
    if (diffDays > 2) {
        isAllowed = true;
    } else if (diffDays === 2 && currentHour < 14) {
        isAllowed = true; // За 2 дня, но время до 14:00
    }
    
    // Если день не проходит проверку — не показываем его
    if (!isAllowed) continue; 
    // ----------------------------------------

    var ukrDayName = daysNames[d.getDay()];
    var isoDate = dStr;
    var isSelected = selectedDays.indexOf(isoDate) !== -1;
    var icon = isSelected ? "✅ " : "⬜️ ";
    
    keyboard.push([{
      text: icon + ukrDayName + " (" + formatDate(checkDate) + ")",
      callback_data: "toggle_day_" + isoDate
    }]);
  }

  if (keyboard.length === 0) {
     sendTelegramMessage(chatId, "🚫 Час замовлення на ці дні вже минув (замовлення приймаються за 2 дні до 14:00). Оберіть наступний тиждень.");
     return;
  }

  if (selectedDays.length > 0) {
    keyboard.push([{ text: "Підтвердити дні ➡️", callback_data: "confirm_days" }]);
  }
  
  keyboard.push([{ text: "🔙 Назад до вибору тижня", callback_data: "back_to_weeks" }]);
  keyboard.push([{ text: "❌ Скасувати замовлення", callback_data: "cancel_order" }]);

  var text = "📅 Оберіть дні доставки (натисніть, щоб поставити галочку):";

  if (messageIdToEdit) {
    editTextMessage(chatId, messageIdToEdit, text, keyboard);
  } else {
    sendTelegramMessage(chatId, text, keyboard);
  }
}

// Хелпер для редактирования сообщений (красивые галочки)
function editTextMessage(chatId, messageId, text, inlineKeyboard) {
  try {
    var payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "HTML",
      reply_markup: JSON.stringify({ inline_keyboard: inlineKeyboard })
    };
    fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/editMessageText", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload)
    });
  } catch(e) {
    logEvent('editError', e.toString());
  }
}

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var chatId = data.message?.chat?.id || data.callback_query?.message?.chat?.id;
  var text = (data.message?.text || "").trim();
  var callbackData = data.callback_query?.data;

  if (!chatId) return ContentService.createTextOutput("ok");

  // --- 1. АДМИН КОМАНДЫ И ФОТО ---
  if (ADMIN_CHAT_IDS.includes(chatId)) {
    
    // Перехват фото (теперь работает независимо от наличия текста)
    if (data.message && data.message.photo) {
      var photoArray = data.message.photo;
      var fileId = photoArray[photoArray.length - 1].file_id; 
      sendTelegramMessage(chatId, "<b>ID вашого фото:</b>\n\n<code>" + fileId + "</code>");
      return ContentService.createTextOutput("ok");
    }

    if (text && text.startsWith("/")) {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var sheet = ss.getSheetByName(CLIENTS_SHEET);
      var parts = text.split(" ");
      switch(parts[0]) {
        case "/forcebind":
          if (parts.length === 3) {
            var phone = normalizePhone(parts[1]);
            var targetChatId = parseInt(parts[2],10);
            var res = bindChatId(phone,targetChatId);
            sendTelegramMessage(chatId,"Force bind result: " + res);
          }
          return ContentService.createTextOutput("ok");

        case "/unbind":
          if (parts.length === 2) {
            var phone = normalizePhone(parts[1]);
            var sheetData = sheet.getDataRange().getValues();
            for(var i=1;i<sheetData.length;i++){
              if(normalizePhone(sheetData[i][PHONE_COL-1])===phone) sheet.getRange(i+1, CHAT_COL).setValue("");
            }
            sendTelegramMessage(chatId,"Unbind done for: " + phone);
          }
          return ContentService.createTextOutput("ok");

        case "/dump":
          var all = sheet.getDataRange().getValues()
              .slice(1)
              .map(r => normalizePhone(r[PHONE_COL-1]) + " : " + (r[CHAT_COL-1] || "—"))
              .join("\n");
          sendTelegramMessage(chatId,"Dump:\n"+all);
          return ContentService.createTextOutput("ok");

        case "/reload":
        var cache = CacheService.getScriptCache();
        var days = ["неділя", "понеділок", "вівторок", "середа", "четвер", "п'ятниця", "субота"];
        days.forEach(day => cache.remove("menu_" + day));
        sendTelegramMessage(chatId, "✅ Кеш меню очищено. Дані будуть оновлені при наступному запиті.");
        return ContentService.createTextOutput("ok");
      }
    }
  }

  // --- 2. ОБРАБОТКА КНОПОК ---
  if (callbackData) {
    if (callbackData === "new_order") {
      handleNewOrder(chatId);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "new_order_edit_inline") {
      handleNewOrder(chatId, data.callback_query.message.message_id);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "submenu_sushka") {
      var keyboard = [
        [{ text: "🔥 Сушка XS (1200-1300 ккал)", callback_data: "view_package_Сушка XS" }],
        [{ text: "🔥 Сушка S (1500-1600 ккал)", callback_data: "view_package_Сушка S" }],
        [{ text: "🔙 Назад", callback_data: "new_order_edit_inline" }]
      ];
      editTextMessage(chatId, data.callback_query.message.message_id, "Оберіть варіант Сушки:", keyboard);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "my_orders") {
      sendMyOrders(chatId);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "main_menu") {
        quickAnswer(data.callback_query.id);
        try { fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", { method: "post", contentType: "application/json", payload: JSON.stringify({ chat_id: chatId, message_id: data.callback_query.message.message_id }) });
        } catch(e) {}
        
        var inlineKeyboard = [
          [{ text: "🛒 Зробити замовлення", callback_data: "new_order" }],
          [{ text: "📋 Мої замовлення", callback_data: "my_orders" }],
          [{ text: "Змінити номер телефону", callback_data: "change_yes" }]
        ];
        sendTelegramMessage(chatId, "Ось ваше головне меню:", inlineKeyboard);
        
        return ContentService.createTextOutput("ok");
    }
    if (callbackData === "change_yes") {
        setUserStatus(chatId, "waiting_for_phone");
        sendTelegramMessage(chatId, "Введіть новий номер телефону:");
        quickAnswer(data.callback_query.id);
        return ContentService.createTextOutput("ok");
    }
    // Просмотр карточки программы
    if (callbackData.startsWith("view_package_")) {
      var pkg = callbackData.replace("view_package_", "");
      showPackageDetails(chatId, pkg, data.callback_query.message.message_id);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    // Возврат из карточки (удаляем фото и шлем текстовое меню заново)
    if (callbackData === "new_order_edit_photo") {
      try {
        fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", {
          method: "post", contentType: "application/json",
          payload: JSON.stringify({ chat_id: chatId, message_id: data.callback_query.message.message_id })
        });
      } catch(e) {}
      handleNewOrder(chatId);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData.startsWith("set_package_")) {
      askWeekSelection(chatId, callbackData.replace("set_package_", ""));
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData.startsWith("set_week_")) {
      var selectedDate = callbackData.replace("set_week_", "");
      var draft = getDraft(chatId);
      if (draft) {
        draft.weekStart = selectedDate;
        draft.selectedDays = [];
        draft.currentDayIndex = 0;
        draft.step = "day_selection";
        saveDraft(chatId, draft);
        askDaySelection(chatId);
      }
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData.startsWith("set_cutlery_")) {
      var amount = callbackData.replace("set_cutlery_", "");
      var draft = getDraft(chatId);
      if (draft) {
        draft.cutlery = amount === "0" ? "Без приборів" : amount + " шт";
        saveDraft(chatId, draft);
        askNotes(chatId);
      }
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "skip_notes") {
      var draft = getDraft(chatId);
      if (draft) {
        draft.notes = "—";
        saveDraft(chatId, draft);
        clearUserStatus(chatId);
        finishOrder(chatId);
      }
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData.startsWith("toggle_day_")) {
      var dateToToggle = callbackData.replace("toggle_day_", "");
      var draft = getDraft(chatId);
      if (draft) {
        draft.selectedDays = draft.selectedDays || [];
        var idx = draft.selectedDays.indexOf(dateToToggle);
        if (idx === -1) {
          draft.selectedDays.push(dateToToggle);
          draft.selectedDays.sort();
        } else {
          draft.selectedDays.splice(idx, 1);
        }
        saveDraft(chatId, draft);
        askDaySelection(chatId, data.callback_query.message.message_id);
      }
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "confirm_days") {
        quickAnswer(data.callback_query.id);
        var draft = getDraft(chatId);
        if (draft) {
            draft.currentDayIndex = 0;
            var pkg = (draft.package || "").toUpperCase();
            // БАЙПАС ДЛЯ СУШКИ (Скіп вибору страв)
            if (pkg.includes("СУШКА")) {
                draft.orders = {};
                var sushkaMenuMap = {
                    "XS": "Фіксоване білкове меню (3 прийоми їжі)",
                    "S":  "Фіксоване білкове меню (4 прийоми їжі)"
                };
                // Шукаємо ключ (XS, S...) у назві обраного пакета
                var sushkaText = "Фіксоване білкове меню"; 
                for (var key in sushkaMenuMap) {
                    if (pkg.includes(key)) {
                        sushkaText = sushkaMenuMap[key];
                        break;
                    }
                }
                for (var i = 0; i < draft.selectedDays.length; i++) {
                     var d = draft.selectedDays[i];
                     draft.orders[d] = [{ category: "Сушка", dish: sushkaText, count: 1 }];
                } 
                saveDraft(chatId, draft);
                try { 
                  fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", { 
                    method: "post", contentType: "application/json", 
                    payload: JSON.stringify({ chat_id: chatId, message_id: data.callback_query.message.message_id }) 
                  }); 
                } catch(e) {}
                askCutlery(chatId);
                return ContentService.createTextOutput("ok");
            }
            saveDraft(chatId, draft);
        }
        startLinearDay(chatId, data.callback_query.message.message_id);
        return ContentService.createTextOutput("ok");
    }
    if (callbackData === "back_to_weeks") {
        var draft = getDraft(chatId);
        if(draft && draft.package) askWeekSelection(chatId, draft.package);
        else handleNewOrder(chatId);
        quickAnswer(data.callback_query.id);
        return ContentService.createTextOutput("ok");
    }
    if (callbackData.startsWith("view_cat_")) {
      showCategoryDishes(chatId, callbackData.replace("view_cat_", ""), data.callback_query.message.message_id, data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "back_to_day_menu") {
      askDishSelection(chatId, data.callback_query.message.message_id);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "back_to_days") {
      askDaySelection(chatId, data.callback_query.message.message_id);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "confirm_order") {
        quickAnswer(data.callback_query.id);
        executeOrder(chatId, data.callback_query.message.message_id);
        return ContentService.createTextOutput("ok");
    }
    
    if (callbackData === "cancel_order") {
        quickAnswer(data.callback_query.id, "Замовлення скасовано.");
        deleteDraft(chatId);
        try { fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", { method: "post", contentType: "application/json", payload: JSON.stringify({ chat_id: chatId, message_id: data.callback_query.message.message_id }) }); } catch(e) {}
        
        var keyboard = [[{ text: "🛒 Зробити замовлення", callback_data: "new_order" }], [{ text: "📋 Мої замовлення", callback_data: "my_orders" }]];
        sendTelegramMessage(chatId, "Ось ваше головне меню:", keyboard);
        return ContentService.createTextOutput("ok");
    }
    
    if (callbackData === "empty_menu") {
        quickAnswer(data.callback_query.id, "⛔️ Меню на цей день ще не заповнено шеф-кухарем.");
        return ContentService.createTextOutput("ok");
    }
    // --- Мгновенный возврат при ручном редактировании (toggle_dish) ---
    if (callbackData.startsWith("toggle_dish_")) {
      var parts = callbackData.replace("toggle_dish_", "").split("_");
      var cat = parts[0];
      var dishIndex = parseInt(parts[1], 10);
      
      var draft = getDraft(chatId);
      var dayIndex = draft.currentDayIndex || 0;
      var date = draft.selectedDays[dayIndex];
      draft.orders = draft.orders || {};
      draft.orders[date] = draft.orders[date] || [];
      
      var daysNames = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
      var menu = getMenuForDay(daysNames[new Date(date).getDay()]);
      var dishList = cat.startsWith("snack") ? menu.allSnacks : menu[cat];
      var dishName = dishList[dishIndex].name;

      var exactDishIdx = -1;
      var categoryIdx = -1;

      for (var k=0; k<draft.orders[date].length; k++) {
         if (draft.orders[date][k].category === cat) {
            categoryIdx = k; 
            if (draft.orders[date][k].dish === dishName) exactDishIdx = k;
         }
      }

      var limit = getPackageLimit(draft.package);
      var currentCount = draft.orders[date].length;
      var isIndiv = draft.package.toLowerCase().includes("інд");

      if (exactDishIdx !== -1) {
        if (isIndiv) {
            if (draft.orders[date][exactDishIdx].count < 3) draft.orders[date][exactDishIdx].count++;
            else draft.orders[date].splice(exactDishIdx, 1);
        } else {
            draft.orders[date].splice(exactDishIdx, 1);
        }
        saveDraft(chatId, draft);
      } else {
        if (categoryIdx !== -1 && !isIndiv) {
            draft.orders[date][categoryIdx].dish = dishName;
            draft.orders[date][categoryIdx].count = 1; 
            saveDraft(chatId, draft);
        } else {
            if (!isIndiv && currentCount >= limit) {
                quickAnswer(data.callback_query.id, "❌ Ліміт страв (" + limit + ") вичерпано!");
                return ContentService.createTextOutput("ok");
            }
            draft.orders[date].push({ category: cat, dish: dishName, count: 1 });
            saveDraft(chatId, draft);
        }
      }
      // ВАЖНО: Вместо того чтобы оставаться в категории, мгновенно выкидываем обратно в финальное меню (Overview)
      askDishSelection(chatId, data.callback_query.message.message_id);
      quickAnswer(data.callback_query.id);
      return ContentService.createTextOutput("ok");
    }
    if (callbackData === "next_day") {
        quickAnswer(data.callback_query.id); // 1. Мгновенно гасим загрузку!
        
        var draft = getDraft(chatId);
        if (!draft || !draft.selectedDays) return ContentService.createTextOutput("ok");

        var currentDayDate = draft.selectedDays[draft.currentDayIndex || 0];
        var ordersForDay = draft.orders?.[currentDayDate] || [];
        var limit = getPackageLimit(draft.package);

        // Если блюд не хватает — выкидываем пуш-уведомление
        if (ordersForDay.length < limit) {
          quickAnswer(data.callback_query.id, "⚠️ Треба обрати ВСІ страви (" + limit + "). У вас обрано: " + ordersForDay.length);
          return ContentService.createTextOutput("ok");
        }

        // 2. Увеличиваем индекс дня
        draft.currentDayIndex = (draft.currentDayIndex || 0) + 1;
        saveDraft(chatId, draft);
        
        // 3. Переход: либо следующий день, либо приборы
        if (draft.currentDayIndex < draft.selectedDays.length) {
            startLinearDay(chatId, data.callback_query.message.message_id); 
        } else {
            // Удаляем меню и переходим к финишным вопросам (приборы -> пожелания)
            try { fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", { method: "post", contentType: "application/json", payload: JSON.stringify({ chat_id: chatId, message_id: data.callback_query.message.message_id }) }); } catch(e) {}
            askCutlery(chatId); 
        }
        return ContentService.createTextOutput("ok");
    }
    // --- Обработка линейного выбора ---
    if (callbackData.startsWith("lin_dish_")) {
        quickAnswer(data.callback_query.id);
        var parts = callbackData.replace("lin_dish_", "").split("_");
        var cat = parts[0]; 
        var dishIndex = parseInt(parts[1], 10);
        
        var draft = getDraft(chatId);
        var date = draft.selectedDays[draft.currentDayIndex || 0];
        draft.orders = draft.orders || {};
        draft.orders[date] = draft.orders[date] || [];

        var daysNames = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
        var menu = getMenuForDay(daysNames[new Date(date).getDay()]);

        // ВИПРАВЛЕННЯ: Беремо страви з allSnacks, якщо це будь-який перекус
        var dishList = cat.startsWith("snack") ? menu.allSnacks : menu[cat];
        var dishName = dishList[dishIndex].name;

        draft.orders[date] = draft.orders[date].filter(o => o.category !== cat); 
        draft.orders[date].push({ category: cat, dish: dishName, count: 1 });
        draft.currentCatIndex++;
        saveDraft(chatId, draft);
        
        if (draft.currentCatIndex < draft.catSequence.length) {
            showLinearCategory(chatId, data.callback_query.message.message_id, data.callback_query.id, false);
        } else {
            askDishSelection(chatId, data.callback_query.message.message_id);
            quickAnswer(data.callback_query.id);
        }
        return ContentService.createTextOutput("ok");
    }

    if (callbackData === "lin_skip") {
        quickAnswer(data.callback_query.id);
        var draft = getDraft(chatId);
        draft.currentCatIndex++;
        saveDraft(chatId, draft);
        if (draft.currentCatIndex < draft.catSequence.length) {
            showLinearCategory(chatId, data.callback_query.message.message_id, data.callback_query.id, false);
        } else {
            askDishSelection(chatId, data.callback_query.message.message_id); // Выкидываем в финал
            quickAnswer(data.callback_query.id);
        }
        return ContentService.createTextOutput("ok");
    }
  }

// --- 3. ОБРАБОТКА ТЕКСТА (Пользовательская логика) ---
  if (text) {
    // 1. Команды из меню (Приоритет)
    if (text === "/new_order") { handleNewOrder(chatId); return ContentService.createTextOutput("ok"); }
    if (text === "/my_orders") { sendMyOrders(chatId); return ContentService.createTextOutput("ok"); }
    if (text === "/change_phone") {
        setUserStatus(chatId, "waiting_for_phone");
        sendTelegramMessage(chatId, "Введіть новий номер телефону у форматі 0XXXXXXXXX:");
        return ContentService.createTextOutput("ok");
    }

    var ssClients = SpreadsheetApp.openById(SHEET_ID);
    var sheetClients = ssClients.getSheetByName(CLIENTS_SHEET);
    var clients = sheetClients.getDataRange().getValues();
    var existingIndexes = [];

    for (var i = 1; i < clients.length; i++) {
        if (clients[i][CHAT_COL-1] == chatId) existingIndexes.push(i); 
    }

    // Если пользователь ЕСТЬ в базе
    if (existingIndexes.length > 0) {
      var status = getUserStatus(chatId);
      
      if (status === "waiting_for_phone") {
        handlePhoneInput(chatId, text);
        return ContentService.createTextOutput("ok");
      }

      if (status === "waiting_for_notes") {
        var draft = getDraft(chatId);
        if (draft) {
          draft.notes = text || "—";
          saveDraft(chatId, draft);
          clearUserStatus(chatId);
          finishOrder(chatId);
        }
        return ContentService.createTextOutput("ok");
      }
      
      clearUserStatus(chatId);
      // Если это просто /start или любой текст от старого юзера — шлем в меню
      var welcome = (text === "/start") ? "Вітаємо! Головне меню:" : "Ось ваше головне меню:";
      showMainMenu(chatId, welcome);
      return ContentService.createTextOutput("ok");
    }

    // Если пользователя НЕТ в базе
    if (text === "/start") {
        sendTelegramMessage(chatId, "Привіт! Для початку роботи введіть свій номер телефону (формат 0XXXXXXXXX) 📞");
    } else {
        handlePhoneInput(chatId, text);
    }
  }

  return ContentService.createTextOutput("ok");
}

// --- Работа с датами ---
function getMonday(d) {
  d = new Date(d);
  var day = d.getDay(),
      diff = d.getDate() - day + (day == 0 ? -6 : 1); // adjust when day is sunday
  return new Date(d.setDate(diff));
}

function formatDate(date) {
  var dd = date.getDate();
  var mm = date.getMonth() + 1;
  return (dd < 10 ? '0' + dd : dd) + '.' + (mm < 10 ? '0' + mm : mm);
}

function toIsoDate(date) {
  // YYYY-MM-DD для JSON и сравнений
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// --- Core рассылки ---
// notifyTodayOrdersCore: отправляет только по времени доставки; chatId берём обязательно из Info
function notifyTodayOrdersCore() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheetClients = ss.getSheetByName(CLIENTS_SHEET);
  var clientsData = sheetClients.getDataRange().getValues();
  var sheetToday = ss.getSheetByName(TODAY_SHEET);
  var todayData = sheetToday.getDataRange().getValues();
  var sent = 0;
  var skipped_no_info_chat = 0;
  var skipped_no_time = 0;

  for (var i = 1; i < todayData.length; i++) {
    var phone = normalizePhone(todayData[i][PHONE_COL-1]);
    var deliveryTime = (todayData[i][DELIVERY_TIME_COL-1] || "").toString().trim();

    if (!deliveryTime) {
      skipped_no_time++;
      continue;
    }

    var infoChat = getChatFromInfoByPhone(phone, clientsData);
    if (infoChat) {
      // перезаписываем Today chatId априори
      todayData[i][CHAT_COL-1] = infoChat;
      var message = `Сьогодні у вас доставка:\nПІБ: <b>${todayData[i][1] || "Невідомо"}</b>\nЧас доставки: ${deliveryTime}⏰`;
      sendTelegramMessage(infoChat, message);
      sent++;
    } else {
      skipped_no_info_chat++;
    }
  }

  // batch update chatId в Today (только колонка Chat)
  if (todayData.length > 1) {
    sheetToday.getRange(2, CHAT_COL, todayData.length-1, 1)
      .setValues(todayData.slice(1).map(r => [r[CHAT_COL-1]]));
  }

  logEvent('notifyTodayOrdersCore', 'sent', sent, 'skipped_no_info_chat', skipped_no_info_chat, 'skipped_no_time', skipped_no_time);
  return { sent: sent, skipped_no_info_chat: skipped_no_info_chat, skipped_no_time: skipped_no_time };
}

// sendNotesTodayCore: отправляет индивидуальные заметки и общую (из H2) — chatId берём из Info
function sendNotesTodayCore() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheetToday = ss.getSheetByName(TODAY_SHEET);
  var todayData = sheetToday.getDataRange().getValues();
  var sheetClients = ss.getSheetByName(CLIENTS_SHEET);
  var clientsData = sheetClients.getDataRange().getValues();

  var individualNotesSent = 0;
  var generalNotesSent = 0;
  var skippedIndividual = [];
  var skippedGeneral = [];

  var generalNote = "";
  if (todayData.length > 1) generalNote = (todayData[1][GENERAL_NOTE_COL-1] || "").toString().trim();

  for (var i = 1; i < todayData.length; i++) {
    var phone = normalizePhone(todayData[i][PHONE_COL-1]);
    var note = (todayData[i][NOTE_COL-1] || "").toString().trim();

    var infoChat = getChatFromInfoByPhone(phone, clientsData);
    if (infoChat) {
      // перезаписываем Today chatId априори
      todayData[i][CHAT_COL-1] = infoChat;

      if (note) {
        sendTelegramMessage(infoChat, `Нотатка для Вас:\n${note}`);
        individualNotesSent++;
      }
      if (generalNote) {
        sendTelegramMessage(infoChat, `Загальна нотатка:\n${generalNote}`);
        generalNotesSent++;
      }
    } else {
      if (note) skippedIndividual.push(todayData[i][1] || phone || ("row " + (i+1)));
      if (generalNote) skippedGeneral.push(todayData[i][1] || phone || ("row " + (i+1)));
    }
  }

  // batch update chatId в Today
  if (todayData.length > 1) {
    sheetToday.getRange(2, CHAT_COL, todayData.length-1, 1)
      .setValues(todayData.slice(1).map(r => [r[CHAT_COL-1]]));
  }

  var summary = `Індивідуальних: ${individualNotesSent}, Загальних: ${generalNotesSent}. Пропущено індивідуальних: ${skippedIndividual.length}, пропущено загальних: ${skippedGeneral.length}`;
  SpreadsheetApp.getUi().alert("Відправлено нотаток:\n" + summary);
  logEvent('sendNotesTodayCore', summary, JSON.stringify({ skippedIndividual, skippedGeneral }));

  return { individualNotesSent, generalNotesSent, skippedIndividual, skippedGeneral };
}

// sendAllToday: агрегация любых полей (time, personal note, general note) и отправка (chatId из Info)
function sendAllToday() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheetToday = ss.getSheetByName(TODAY_SHEET);
  var data = sheetToday.getDataRange().getValues();
  var sheetClients = ss.getSheetByName(CLIENTS_SHEET);
  var clientsData = sheetClients.getDataRange().getValues();

  var sent = 0;
  var skippedNoChat = [];
  var skippedNoFields = [];

  var generalNote = "";
  if (data.length > 1) generalNote = (data[1][GENERAL_NOTE_COL - 1] || "").toString().trim();

  for (var i = 1; i < data.length; i++) {
    var name = data[i][1] || "Невідомо";
    var phone = normalizePhone(data[i][PHONE_COL - 1]);
    var time = (data[i][DELIVERY_TIME_COL - 1] || "").toString().trim();
    var note = (data[i][NOTE_COL - 1] || "").toString().trim();

    // если нет ничего — пропускаем
    if (!time && !note && !generalNote) {
      skippedNoFields.push(name + (phone ? " ("+phone+")" : ""));
      continue;
    }

    // chatId исключительно из Info
    var infoChat = getChatFromInfoByPhone(phone, clientsData);
    if (!infoChat) {
      skippedNoChat.push(name + (phone ? " ("+phone+")" : ""));
      continue;
    }

    // перезаписываем Today chatId априори
    data[i][CHAT_COL - 1] = infoChat;

    var parts = [];
    parts.push(`ПІБ: <b>${name}</b>`);
    if (time) parts.push(`Час доставки: ${time}⏰`);
    if (note) parts.push(`<b>Нотатка для Вас:</b>\n${note}`);
    if (generalNote) parts.push(`<b>Загальна нотатка:</b>\n${generalNote}`);

    var message = `Сьогодні у вас інформація:\n` + parts.join("\n\n");
    sendTelegramMessage(infoChat, message);
    Utilities.sleep(600);
    sent++;
  }

  // batch update chatId в Today
  if (data.length > 1) {
    sheetToday.getRange(2, CHAT_COL, data.length-1, 1)
      .setValues(data.slice(1).map(r => [r[CHAT_COL-1]]));
  }

  var summary = `Відправлено: ${sent}\nПропущено (немає полей): ${skippedNoFields.length}\nПропущено (немає chat в Info): ${skippedNoChat.length}`;
  SpreadsheetApp.getUi().alert(summary);
  logEvent('sendAllToday', summary, JSON.stringify({ skippedNoFields, skippedNoChat }));
}

// preview — показывает, что будет отправлено (использует chatId из Info)
function previewTodayMessages() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheetToday = ss.getSheetByName(TODAY_SHEET);
  var data = sheetToday.getDataRange().getValues();
  var sheetClients = ss.getSheetByName(CLIENTS_SHEET);
  var clientsData = sheetClients.getDataRange().getValues();

  var messages = [];
  var skipped = 0;

  var generalNote = "";
  if (data.length > 1) generalNote = (data[1][GENERAL_NOTE_COL - 1] || "").toString().trim();

  for (var i = 1; i < data.length; i++) {
    var name = data[i][1] || "Невідомо";
    var phone = normalizePhone(data[i][PHONE_COL - 1]);
    var infoChat = getChatFromInfoByPhone(phone, clientsData);
    var time = (data[i][DELIVERY_TIME_COL - 1] || "").toString().trim();
    var note = (data[i][NOTE_COL - 1] || "").toString().trim();

    if (!time && !note && !generalNote) {
      skipped++;
      continue;
    }

    var msg = `ПІБ: ${name}\nТел: ${phone}\nChat (Info): ${infoChat || "—"}\nЧас доставки: ${time || "—"}`;
    if (note) msg += `\nНотатка для Вас: ${note}`;
    if (generalNote) msg += `\nЗагальна нотатка: ${generalNote}`;

    messages.push(msg);
  }

  var summary = `📋 Попередній перегляд повідомлень (${messages.length} шт.)\n\n` +
                messages.join("\n\n──────────────\n\n") +
                `\n\n⚠️ Пропущено ${skipped} запис(ів) (немає жодного поля для відправки)`;

  SpreadsheetApp.getUi().alert(summary);
}

// sendTestToday — шлёт тестовые сообщения в TEST_CHAT_ID, показывает целевой chatId (из Info)
function sendTestToday() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheetClients = ss.getSheetByName(CLIENTS_SHEET);
  var clientsData = sheetClients.getDataRange().getValues();
  var sheetToday = ss.getSheetByName(TODAY_SHEET);
  var todayData = sheetToday.getDataRange().getValues();
  var sent = 0;

  var generalNote = "";
  if (todayData.length > 1) generalNote = (todayData[1][GENERAL_NOTE_COL-1] || "").toString().trim();

  for (var i = 1; i < todayData.length; i++) {
    var phone = normalizePhone(todayData[i][PHONE_COL-1]);
    var infoChat = getChatFromInfoByPhone(phone, clientsData);
    var name = todayData[i][1] || "Невідомо";
    var time = (todayData[i][DELIVERY_TIME_COL-1] || "—").toString();
    var note = (todayData[i][NOTE_COL-1] || "").toString().trim();

    var parts = [];
    parts.push(`ПІБ: <b>${name}</b>`);
    parts.push(`Час доставки: ${time}`);
    if (note) parts.push(`Нотатка для Вас:\n${note}`);
    if (generalNote) parts.push(`Загальна нотатка:\n${generalNote}`);
    var message = `ТЕСТОВО → To: ${infoChat || "—"}\n\n` + parts.join("\n\n");

    sendTelegramMessage(TEST_CHAT_ID, message);
    sent++;
  }

  SpreadsheetApp.getUi().alert(`Тестова розсилка завершена. Повідомлень відправлено: ${sent}`);
}

// --- Обёртки для меню (чтобы меню вызывало существующие core-функции) ---
function sendNotesToday() {
  // вызывает core, который сам показывает подробный алерт/лог
  sendNotesTodayCore();
}

function sendTodayNow() {
  // notifyTodayOrdersCore возвращает объект {sent, skipped_no_info_chat, skipped_no_time}
  var res = notifyTodayOrdersCore();
  SpreadsheetApp.getUi().alert(
    'Відправлено замовлень сьогодні: ' + (res.sent || 0) +
    '\nПропущено (немає chat в Info): ' + (res.skipped_no_info_chat || 0) +
    '\nПропущено (немає часу): ' + (res.skipped_no_time || 0)
  );
}

function exportToExternalSheet() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt("Експорт в 'Учет блюд'", "Введіть дату доставки (формат: 16.02):", ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var fullDate = response.getResponseText().trim();
  if (!fullDate) return;

  var match = fullDate.match(/^(\d{2}\.\d{2})/);
  if (!match) {
    ui.alert("Неправильний формат дати.");
    return;
  }
  var targetSheetName = match[1];

  try {
    var extSS = SpreadsheetApp.openById(EXTERNAL_SHEET_ID);
    var extSheet = extSS.getSheetByName(targetSheetName);

    if (!extSheet) {
      ui.alert("Лист з назвою '" + targetSheetName + "' не знайдено!");
      return;
    }

    var localSS = SpreadsheetApp.openById(SHEET_ID);
    var ordersSheet = localSS.getSheetByName(ORDERS_SHEET);
    var infoSheet = localSS.getSheetByName(CLIENTS_SHEET);


    var extData = extSheet.getRange("A1:L1000").getValues();
    var ordMaxRow = Math.max(ordersSheet.getLastRow(), 1);
    var orders = ordersSheet.getRange(1, 1, ordMaxRow, 13).getValues();
    var infoData = infoSheet.getDataRange().getValues();


    function cleanId(val) {
        if (!val) return "";
        return String(val).split('.')[0].replace(/\D/g, "");
    }

    var infoLookup = {};
    for (var j = 1; j < infoData.length; j++) {
       var infoChatId = cleanId(infoData[j][4]); // Колонка E (Chat ID)
       if (infoChatId) {
          infoLookup[infoChatId] = {
             cutlery: String(infoData[j][6] || "").trim(), // Колонка G (Прибори)
             notes: String(infoData[j][7] || "").trim()    // Колонка H (Особливості)
          };
       }
    }



    var availableRows = {};

    for (var r = 0; r < extData.length; r++) { 
       var chatIdCell = cleanId(extData[r][5]); // Індекс 5 - Колонка F
       var rationCell = String(extData[r][6]).trim(); // Індекс 6 - Колонка G

       if (chatIdCell.length >= 6 && rationCell === "") {
          if (!availableRows[chatIdCell]) availableRows[chatIdCell] = [];
          availableRows[chatIdCell].push(r + 1);
       }
    }

    var updates = [];
    var missing = [];

    for (var i = 1; i < orders.length; i++) {
      var dateDelivery = String(orders[i][4]);
      var isPaid = (orders[i][10] === true || String(orders[i][10]).toUpperCase() === "TRUE");

      if (isPaid && dateDelivery.includes(fullDate)) {
         var localChatId = cleanId(orders[i][1]);
         var localPhone = orders[i][0];

         var packageType = orders[i][5];
         var summary = orders[i][6].replace(/^Пакет.*:\n/i, "")
                                   .replace(/🔹 /g, "")
                                   .replace(/\s\(\d+\sшт\)/g, "")
                                   .split("\n")
                                   .map(s => s.split(": ")[1] || s)
                                   .join(" + ");
                                   
         var orderCutlery = String(orders[i][11] || "").trim();
         var orderNotes = String(orders[i][12] || "").trim();

         var infoCutlery = infoLookup[localChatId] ? infoLookup[localChatId].cutlery : "";
         var infoNotes = infoLookup[localChatId] ? infoLookup[localChatId].notes : "";

         var cutlery = orderCutlery || infoCutlery || "—";
         var notes = orderNotes || infoNotes || "—";


         if (availableRows[localChatId] && availableRows[localChatId].length > 0) {
            var targetRow = availableRows[localChatId].shift(); 
            updates.push({
               row: targetRow,
               data: [packageType, summary, cutlery, notes]
            });
         } else {
            missing.push("Тел: " + localPhone + " | ChatID: " + localChatId);
         }
      }
    }

    if (updates.length > 0) {
       for (var u = 0; u < updates.length; u++) {
          // Запис у 4 стовпці, починаючи з 7-го (Колонки G, H, I, J)
          extSheet.getRange(updates[u].row, 7, 1, 4).setValues([updates[u].data]);
       }
    }
    
    var alertMsg = "Експорт завершено!\nЕкспортовано замовлень: " + updates.length;
    if (missing.length > 0) {
       alertMsg += "\n\nПОМИЛКА: Для наступних замовлень не знайдено ChatID або не вистачило вільних рядків у шаблоні:\n" + missing.join("\n");
    }
    ui.alert(alertMsg);

  } catch (e) {
    ui.alert("Системна помилка:\n" + e.message);
  }
}

// --- UI меню ---
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Delivery')
    .addItem('Зібрати таблицю Today (по даті)', 'buildTodaySheet')
    .addItem('Підтвердити оплати (зміна статусу + повідомлення)', 'confirmPayments')
    .addItem('Експортувати дані в файл (по дням который)', 'exportToExternalSheet')
    .addSeparator()
    .addItem('Відправити сьогоднішні нотатки', 'sendNotesToday')
    .addItem('Відправити сьогоднішній час доставки', 'sendTodayNow')
    .addItem('Відправити ВСЕ (час доставки + персональні та загальні нотатки)', 'sendAllToday')
    .addSeparator()
    .addItem('Попередній перегляд повідомлень', 'previewTodayMessages')
    .addItem('Тестова розсилка на мій чат', 'sendTestToday')
    .addToUi();
}

// --- Чтение меню из таблицы (Smart Search + Cache) ---
function getMenuForDay(dayName) {
  var search = dayName.toLowerCase();
  var cache = CacheService.getScriptCache();
  var cachedMenu = cache.get("menu_" + search);

  if (cachedMenu) {
    return JSON.parse(cachedMenu);
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var menuSheet = ss.getSheetByName(MENU_SHEET);
  var data = menuSheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var cellVal = String(data[i][0]).toLowerCase();
    if (cellVal.includes(search)) {
      // Внутри функции getMenuForDay измени объект result:
      var result = {
        photoId: String(data[i][1] || "").trim(),
        breakfast: [parseDishName(data[i][2]), parseDishName(data[i][3])].filter(d => d.name),
        lunch:     [parseDishName(data[i][4]), parseDishName(data[i][5])].filter(d => d.name),
        dinner:    [parseDishName(data[i][6]), parseDishName(data[i][7])].filter(d => d.name),
        // Объединяем колонки I и J в один массив страв
        allSnacks: [parseDishName(data[i][8]), parseDishName(data[i][9])].filter(d => d.name)
      };
      cache.put("menu_" + search, JSON.stringify(result), 600);
      return result;
    }
  }
  return null;
}

// Разделяет "Борщ || Borch" на объект
function parseDishName(rawString) {
  if (!rawString) return { name: "", short: "" };
  var parts = rawString.toString().split("||");
  var fullName = parts[0].trim();
  var shortName = parts.length > 1 ? parts[1].trim() : fullName; 
  return { name: fullName, short: shortName };
}

// Получить лимит блюд по пакету
function getPackageLimit(packageName) {
  if (!packageName) return 4;
  var p = packageName.toLowerCase();
  if (p.includes("слім") || p.includes("slim") || p.includes("слим")) return 3;
  if (p.includes("sport")) return 5; // Додано ліміт 5 для Sport Active+
  return 4; // Balance, Active
}

// --- Линейный алгоритм выбора (Шаг за шагом) ---
function startLinearDay(chatId, messageIdToEdit) {
  var draft = getDraft(chatId);
  if (!draft || !draft.package) return;
  
  var p = draft.package.toLowerCase();
  var isSlim = p.includes("slim") || p.includes("слім");
  var isSport = p.includes("sport");

  // Формуємо послідовність кроків
  draft.catSequence = ["breakfast", "lunch", "dinner"];
  if (isSport) {
    draft.catSequence.push("snack1", "snack2"); // Два кроки для Спорту
  } else if (!isSlim) {
    draft.catSequence.push("snack"); // Один крок для Balance/Active
  }

  draft.currentCatIndex = 0;
  saveDraft(chatId, draft);
  showLinearCategory(chatId, messageIdToEdit, null, true);
}

function showLinearCategory(chatId, messageIdToEdit, queryId, forceResend) {
  if (queryId) quickAnswer(queryId);
  var draft = getDraft(chatId);
  var dateStr = draft.selectedDays[draft.currentDayIndex || 0];
  var dayName = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"][new Date(dateStr).getDay()];
  var menu = getMenuForDay(dayName);
  
  var category = draft.catSequence[draft.currentCatIndex];
  var dishes = (menu && menu[category]) ? menu[category] : [];
  
  if (category.startsWith("snack")) {
    dishes = menu.allSnacks || [];
  }
  // Если категория пустая в таблице - пропускаем её
  if (dishes.length === 0) {
      draft.currentCatIndex++;
      saveDraft(chatId, draft);
      if (draft.currentCatIndex < draft.catSequence.length) showLinearCategory(chatId, messageIdToEdit, null, forceResend);
      else askDishSelection(chatId, messageIdToEdit); // Переход к финальному обзору
      return;
  }
  
  var keyboard = dishes.map((d, i) => ([{ text: d.name, callback_data: `lin_dish_${category}_${i}` }]));
  keyboard.push([{ text: "Пропустити ➡️", callback_data: "lin_skip" }]);
  
  var catUkr = {
  'breakfast': 'Сніданок',
  'lunch': 'Обід',
  'dinner': 'Вечеря',
  'snack': 'Перекус',
  'snack1': 'Перекус 1',
  'snack2': 'Перекус 2'
}[category];
  var text = `📅 <b>${dayName}</b>\nКрок ${draft.currentCatIndex + 1}/${draft.catSequence.length} — ${catUkr}\nОберіть страву:`;
  var isPhoto = (menu.photoId && menu.photoId.length > 10);
  
  if (forceResend) {
      if (messageIdToEdit) { try { fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", { method: "post", contentType: "application/json", payload: JSON.stringify({ chat_id: chatId, message_id: messageIdToEdit }) }); } catch(e) {} }
      if (isPhoto) sendTelegramPhoto(chatId, menu.photoId, text, keyboard);
      else sendTelegramMessage(chatId, text, keyboard);
  } else {
      var payload = { chat_id: chatId, message_id: messageIdToEdit, parse_mode: "HTML", reply_markup: JSON.stringify({ inline_keyboard: keyboard }) };
      if (isPhoto) {
          payload.caption = text;
          try { fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/editMessageCaption", { method: "post", contentType: "application/json", payload: JSON.stringify(payload) }); } catch(e) {}
      } else {
          payload.text = text;
          try { fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/editMessageText", { method: "post", contentType: "application/json", payload: JSON.stringify(payload) }); } catch(e) {}
      }
  }
}

// --- Логика заказа: Шаг 4 (Категории) ---
function askDishSelection(chatId, messageIdToEdit) {
  var draft = getDraft(chatId);
  if (!draft || !draft.selectedDays || draft.selectedDays.length === 0) {
    sendTelegramMessage(chatId, "⚠️ Оберіть дні спочатку.");
    return;
  }

  var dayIndex = draft.currentDayIndex || 0;
  if (dayIndex >= draft.selectedDays.length) {
    askCutlery(chatId); 
    return;
  }

  var currentDayDate = draft.selectedDays[dayIndex];
  var dateObj = new Date(currentDayDate);
  var daysNames = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
  var dayName = daysNames[dateObj.getDay()];

  var menu = getMenuForDay(dayName);
  if (!menu) {
    sendTelegramMessage(chatId, `❌ На ${dayName} (${currentDayDate}) меню ще не заповнено.`);
    return;
  }

  var ordersForDay = (draft.orders && draft.orders[currentDayDate]) ? draft.orders[currentDayDate] : [];
  var limit = getPackageLimit(draft.package);
  var currentCount = ordersForDay.length;
  var remaining = limit - currentCount;
  var statusLine = (remaining > 0) ? `\n\n⚠️ Потрібно обрати ще: <b>${remaining}</b> позиції` : `\n\n✅ Денне меню сформовано!`;

  // --- ВНУТРІШНЯ ФУНКЦІЯ (ЯКА БУЛА ВІДСУТНЯ) ---
  function makeCatBtn(catCode, catName, dishArray) {
    if (!dishArray || dishArray.length === 0) return null;
    var selectedInCat = ordersForDay.filter(o => o.category === catCode).length;
    var icon = selectedInCat > 0 ? "✅ " : "⚪️ ";
    return { text: icon + catName, callback_data: "view_cat_" + catCode };
  }
  // -------------------------------------------

  var p = (draft.package || "").toLowerCase();
  var isSlim = p.includes("slim") || p.includes("слім");
  var isSport = p.includes("sport");
  var isStandard = !isSlim && !isSport;

  var keyboard = [];
  keyboard.push([
    makeCatBtn("breakfast", "Сніданок", menu.breakfast),
    makeCatBtn("lunch", "Обід", menu.lunch)
  ].filter(Boolean));

  var row2 = [makeCatBtn("dinner", "Вечеря", menu.dinner)];
  if (isStandard) {
    row2.push(makeCatBtn("snack", "Перекус", menu.allSnacks));
  }
  keyboard.push(row2.filter(Boolean));

  if (isSport) {
    var rowSport = [
      makeCatBtn("snack1", "Перекус 1 🍎", menu.allSnacks),
      makeCatBtn("snack2", "Перекус 2 🍏", menu.allSnacks)
    ].filter(Boolean);
    keyboard.push(rowSport);
  }

  var nextText = (dayIndex < draft.selectedDays.length - 1) ? "Наступний день ➡️" : "✅ Оформити замовлення";
  keyboard.push([{ text: nextText, callback_data: "next_day" }]);
  keyboard.push([{ text: "🔙 Змінити дні", callback_data: "back_to_days" }]);
  keyboard.push([{ text: "❌ Скасувати замовлення", callback_data: "cancel_order" }]);

  var hint = isSport ? "\n\n<i>*У вашому пакеті 2 перекуси. Ви можете обрати однакові страви в обох категоріях.</i>" : "";
  
  var text = `📅 <b>${dayName} (${formatDate(dateObj)})</b>\n` +
             `Пакет: ${draft.package}\n` +
             `Обрано страв: <b>${currentCount} / ${limit}</b>` + statusLine + hint +
             `\n\nОберіть категорію:`;

  if (messageIdToEdit) {
    try { fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", { method: "post", contentType: "application/json", payload: JSON.stringify({ chat_id: chatId, message_id: messageIdToEdit }) });
    } catch(e) {}
  }

  if (menu.photoId && menu.photoId.length > 10) {
    sendTelegramPhoto(chatId, menu.photoId, text, keyboard);
  } else {
    sendTelegramMessage(chatId, text, keyboard);
  }
}

// вечеря/сниданок/обид/перекус
function showCategoryDishes(chatId, category, messageIdToEdit, queryId) {
  var draft = getDraft(chatId);
  var dayIndex = draft.currentDayIndex || 0;
  var currentDayDate = draft.selectedDays[dayIndex];
  var dateObj = new Date(currentDayDate);
  var daysNames = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
  var dayName = daysNames[dateObj.getDay()];
  
  var menu = getMenuForDay(dayName);
  var dishes = (menu && menu[category]) ? menu[category] : [];

  if (category === "snack" || category === "snack1" || category === "snack2") {
    dishes = menu.allSnacks || [];
  }

  if (dishes.length === 0) {
    quickAnswer(queryId, "⚠️ Категорія '" + category + "' на " + dayName + " порожня.");
    return;
  }

  var ordersForDay = (draft.orders && draft.orders[currentDayDate]) ? draft.orders[currentDayDate] : [];
  var keyboard = [];
  
  for (var i = 0; i < dishes.length; i++) {
    var dishName = dishes[i].name;
    var selectedItem = ordersForDay.find(o => o.category === category && o.dish === dishName);
    
    var icon = selectedItem ? "✅ " : "⬜️ ";
    var countLabel = (selectedItem && selectedItem.count > 1) ? (" — " + selectedItem.count + " шт") : "";
    
    keyboard.push([{ 
      text: icon + dishName + countLabel, 
      callback_data: `toggle_dish_${category}_${i}` 
    }]);
  }

  keyboard.push([{ text: "🔙 Назад", callback_data: "back_to_day_menu" }]);
  var catUkr = category === 'breakfast' ? 'Сніданок' : category === 'lunch' ? 'Обід' : category === 'dinner' ? 'Вечеря' : 'Перекус';
  var text = `🍽 <b>${dayName}</b> — ${catUkr}\nОберіть страву:`;

  // ОПРЕДЕЛЕНИЕ МЕТОДА: если в меню есть фото, используем Caption
  var isPhoto = (menu.photoId && menu.photoId.length > 10);
  var method = isPhoto ? "editMessageCaption" : "editMessageText";
  
  var payload = {
    chat_id: chatId,
    message_id: messageIdToEdit,
    parse_mode: "HTML",
    reply_markup: JSON.stringify({ inline_keyboard: keyboard })
  };
  
  if (isPhoto) payload.caption = text; else payload.text = text;

  fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/" + method, {
    method: "post", contentType: "application/json", payload: JSON.stringify(payload)
  });

  quickAnswer(queryId); 
}

// --- Логика заказа: Шаг 5 (Приборы) ---
function askCutlery(chatId) {
  var draft = getDraft(chatId);
  draft.step = "cutlery";
  saveDraft(chatId, draft);

  var keyboard = [
    [{ text: "1", callback_data: "set_cutlery_1" }, { text: "2", callback_data: "set_cutlery_2" }],
    [{ text: "3", callback_data: "set_cutlery_3" }, { text: "4", callback_data: "set_cutlery_4" }],
    [{ text: "Без приборів ❌", callback_data: "set_cutlery_0" }]
  ];
  keyboard.push([{ text: "❌ Скасувати замовлення", callback_data: "cancel_order" }]);
  sendTelegramMessage(chatId, "🍴 Оберіть кількість приборів:", keyboard);
}

// --- Логика заказа: Шаг 6 (Пожелания) ---
function askNotes(chatId) {
  var draft = getDraft(chatId);
  draft.step = "notes";
  saveDraft(chatId, draft);

  var keyboard = [
    [{ text: "Пропустити ➡️", callback_data: "skip_notes" }]
  ];
  keyboard.push([{ text: "❌ Скасувати замовлення", callback_data: "cancel_order" }]);
  setUserStatus(chatId, "waiting_for_notes");
  sendTelegramMessage(chatId, "📝 Напишіть ваші побажання або особливості (наприклад: 'не їм цибулю','алергія на яйця'):\n\nАбо натисніть 'Пропустити', якщо побажань немає.", keyboard);
}

// --- Финиш: Сохранение в таблицу Orders (Сгруппированный заказ) ---
function executeOrder(chatId, messageId){
  var draft = getDraft(chatId);
  if (!draft || !draft.orders) {
    sendTelegramMessage(chatId, "⚠️ Помилка: Кошик порожній.");
    return;
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var infoSheet = ss.getSheetByName(CLIENTS_SHEET);
  var clients = infoSheet.getDataRange().getValues();
  
  var phone = "";
  
  // Достаем телефон из Info
  for (var i = 1; i < clients.length; i++) {
     if (clients[i][CHAT_COL-1] == chatId) {
         phone = clients[i][PHONE_COL-1];
         break;
     }
  }

  var ordersSheet = ss.getSheetByName(ORDERS_SHEET);
  var newRows = [];
  var now = new Date();
  var timeZone = Session.getScriptTimeZone();

  function getNiceDate(dateObj) {
     var d = new Date(dateObj);
     var days = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
     var dd = d.getDate();
     var mm = d.getMonth() + 1;
     return (dd < 10 ? '0'+dd : dd) + "." + (mm < 10 ? '0'+mm : mm) + " (" + days[d.getDay()] + ")";
  }

  var catNames = { "breakfast": "Сніданок", "lunch": "Обід", "dinner": "Вечеря", "snack1": "Перекус 1", "snack2": "Перекус 2" };

  for (var dateKey in draft.orders) {
     var dayOrders = draft.orders[dateKey];
     if (!dayOrders || dayOrders.length === 0) continue;

     var orderText = "Пакет " + draft.package + ":\n";
     for (var k = 0; k < dayOrders.length; k++) {
         var item = dayOrders[k];
         if (item.category === "Сушка") {
             orderText += "🔹 " + item.dish + "\n";
         } else {
             var catName = catNames[item.category] || item.category;
             orderText += "🔹 " + catName + ": " + item.dish + " (" + item.count + " шт)\n";
         }
     }

     var row = [
         "'" + phone,                                    // A: Телефон
         chatId,                                         // B: Chat id
         getNiceDate(now),                               // C: Дата заказа
         getNiceDate(draft.weekStart),                   // D: Начало недели
         getNiceDate(dateKey),                           // E: День еды
         draft.package,                                  // F: Категория
         orderText.trim(),                               // G: Блюдо
         1,                                              // H: Количество
         Utilities.formatDate(now, timeZone, "HH:mm:ss"),// I: Время записи
         "Новий",                                        // J: Статус
         false,                                          // K: Оплачено
         draft.cutlery || "—",                           // L: Прибори (из бота)
         draft.notes || "—"                              // M: Особливості (из бота)
     ];
     newRows.push(row);
  }

  if (newRows.length === 0) {
     sendTelegramMessage(chatId, "Замовлення скасовано: не обрано жодної страви.");
     deleteDraft(chatId);
     return;
  }

  var colA = ordersSheet.getRange("A:A").getValues();
  var insertRow = 1;
  for (var r = 0; r < colA.length; r++) {
    if (colA[r][0] === "") {
      insertRow = r + 1;
      break;
    }
  }
  
  ordersSheet.getRange(insertRow, 1, newRows.length, newRows[0].length).setValues(newRows);
  ordersSheet.getRange(insertRow, 11, newRows.length).insertCheckboxes();
  deleteDraft(chatId);

  try { 
    fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/deleteMessage", { 
      method: "post", 
      contentType: "application/json", 
      payload: JSON.stringify({ chat_id: chatId, message_id: messageId }) 
    }); 
  } catch(e) {}

  var keyboard = [
      [{ text: "📋 Мої замовлення", callback_data: "my_orders" }],
      [{ text: "🛒 Нове замовлення", callback_data: "new_order" }]
  ];
  sendTelegramMessage(chatId, "✅ <b>Ваше замовлення прийнято!</b>\n\nДані передані адміністратору. Будь ласка, очікуйте підтвердження оплати.", keyboard);

  var adminMsg = `🚨 <b>Нове замовлення!</b>\nКлієнт: ${phone}\nПакет: ${draft.package}\nДнів: ${Object.keys(draft.orders).length}\nПрибори: ${draft.cutlery || "—"}\nОсобливості: ${draft.notes || "—"}\n\nПеревірте таблицю Orders.`;
  ADMIN_CHAT_IDS.forEach(function(adminId) {
    sendTelegramMessage(adminId, adminMsg);
  });
}

function finishOrder(chatId) {
  var draft = getDraft(chatId);
  if (!draft || !draft.orders) {
    sendTelegramMessage(chatId, "⚠️ Помилка: Кошик порожній.");
    return;
  }

  var orderText = "🛒 <b>Підсумок замовлення</b>\nПакет: <b>" + draft.package + "</b>\n\n";
  var catNames = { "breakfast": "Сніданок", "lunch": "Обід", "dinner": "Вечеря", "snack1": "Перекус 1", "snack2": "Перекус 2" };

  for (var dateKey in draft.orders) {
     var dayOrders = draft.orders[dateKey];
     if (!dayOrders || dayOrders.length === 0) continue;
     orderText += "📅 <b>" + dateKey + "</b>\n";
     for (var k = 0; k < dayOrders.length; k++) {
         var item = dayOrders[k];
         if (item.category === "Сушка") {
             orderText += "🔹 " + item.dish + "\n";
         } else {
             var catName = catNames[item.category] || item.category;
             orderText += "🔹 " + catName + ": " + item.dish + " (" + item.count + " шт)\n";
         }
     }
     orderText += "\n";
  }
  orderText += "🍽 Прибори: " + (draft.cutlery || "—") + "\n📝 Особливості: " + (draft.notes || "—");

  var keyboard = [
    [{ text: "✅ Підтвердити та відправити", callback_data: "confirm_order" }],
    [{ text: "❌ Скасувати замовлення", callback_data: "cancel_order" }]
  ];
  sendTelegramMessage(chatId, orderText, keyboard);
}

// Подтвреждение оплаты, через кнопку (В таблицах)
function confirmPayments() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(ORDERS_SHEET);
  var data = sheet.getDataRange().getValues();

  var infoSheet = ss.getSheetByName(CLIENTS_SHEET);
  var infoData = infoSheet.getDataRange().getValues();
  var infoModified = false;
  
  var usersToNotify = {};
  var rowsToConfirm = [];
  var rowsToRevert = [];

  for (var i = 1; i < data.length; i++) {
    var phone = data[i][0];           // Колонка A (Телефон, индекс 0)
    var chatId = data[i][1];          // Колонка B (Chat id, индекс 1)
    var orderSummary = data[i][6];        // Колонка G: текст замовлення
    var foodDay = data[i][4];             // Колонка E: дата замовлення
    var status = String(data[i][9]).trim(); // Колонка J (Статус, индекс 9)
    var isPaid = data[i][10];         // Колонка K (Оплачено, индекс 10)

    var packageType = data[i][5];
    var cutlery = data[i][11] || "—";
    var notes = data[i][12] || "—";

    if (!phone) continue;

    if (isPaid === true) {
      // Відправляємо повідомлення ТІЛЬКИ якщо статус не "Оплачено" і не "Перенесено"
      if (status !== "Оплачено" && status !== "Перенесено") {
        rowsToConfirm.push(i + 1);
        if (chatId) {
            // Групуємо замовлення за користувачем, якщо їх декілька
            if (!usersToNotify[chatId]) usersToNotify[chatId] = [];
            usersToNotify[chatId].push("📅 <b>На дату: " + foodDay + "</b>\n" + orderSummary);

            // Синхронізація з Info
            for (var j = 1; j < infoData.length; j++) {
                if (infoData[j][CHAT_COL-1] == chatId) {
                    infoData[j][5] = packageType; // F: Пакет
                    infoData[j][6] = cutlery;     // G: Прибори
                    infoData[j][7] = notes;       // H: Особливості
                    infoModified = true;
                    break;
                }
            }
        }
      }
    } else {
      if (status !== "Новий") {
        rowsToRevert.push(i + 1);
      }
    }
  }

  if (rowsToConfirm.length === 0 && rowsToRevert.length === 0) {
    SpreadsheetApp.getUi().alert("Немає змін для обробки.");
    return;
  }

  // Запись статуса идет строго в 10-ю колонку (J)
  for (var r = 0; r < rowsToConfirm.length; r++) {
    sheet.getRange(rowsToConfirm[r], 10).setValue("Оплачено"); 
  }
  
  for (var r = 0; r < rowsToRevert.length; r++) {
    sheet.getRange(rowsToRevert[r], 10).setValue("Новий"); 
  }

  // Вивантаження оновленого профілю клієнтів
  if (infoModified) {
      var outData = infoData.slice(1).map(function(row) {
          while (row.length < 8) row.push(""); // Забезпечення масиву до колонки H
          return row.slice(0, 8);
      });
      infoSheet.getRange(2, 1, outData.length, 8).setValues(outData);
  }

  var count = 0;
  for (var chat in usersToNotify) {
    if (chat) {
       var fullMessage = "✅ <b>Оплату отримано. Замовлення підтверджено!</b>\n\n" + 
                         usersToNotify[chat].join("\n\n──────────────\n\n");
       
       sendTelegramMessage(chat, fullMessage);
       Utilities.sleep(100);
       count++;
    }
  }

  SpreadsheetApp.getUi().alert(
    "Статуси 'Оплачено': " + rowsToConfirm.length + 
    "\nСтатуси 'Новий' (перезаписано): " + rowsToRevert.length + 
    "\nПовідомлень: " + count
  );
}

// сборка листа "today"
function buildTodaySheet() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt("Формування таблиці Today", "Введіть дату доставки (формат: 16.02):", ui.ButtonSet.OK_CANCEL);
  
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var targetDate = response.getResponseText().trim();
  
  if (!targetDate) return;

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var ordersSheet = ss.getSheetByName(ORDERS_SHEET);
  var todaySheet = ss.getSheetByName(TODAY_SHEET);
  var infoSheet = ss.getSheetByName(CLIENTS_SHEET);

  var orders = ordersSheet.getDataRange().getValues();
  var info = infoSheet.getDataRange().getValues();

  var newRows = [];
  var rowsToMark = [];

  for (var i = 1; i < orders.length; i++) {
    var isPaid = orders[i][10]; 
    var dateDelivery = String(orders[i][4]); 
    var status = String(orders[i][9]).trim();
    
    if (isPaid === true && dateDelivery.includes(targetDate) && status !== "Перенесено") {
      var phone = normalizePhone(orders[i][0]); 
      var chatId = orders[i][1];                
      var packageType = orders[i][5];           
      var summary = orders[i][6].replace(/^Пакет.*:\n/i, "").trim(); 
      var cutlery = orders[i][11] || "";        
      var notes = orders[i][12] || "";          

      var clientName = "—";
      var clientAddress = "—";
      
      for (var j = 1; j < info.length; j++) {
        if (normalizePhone(info[j][PHONE_COL-1]) === phone) {
          clientName = info[j][1] || "—";    
          clientAddress = info[j][3] || "—"; 
          break;
        }
      }

      newRows.push([
        "",             
        clientName,     
        "'" + phone,    
        clientAddress,  
        chatId,         
        "",             
        "",             
        "",             
        packageType,    
        summary,        
        cutlery,        
        notes,          
        ""              
      ]);
      rowsToMark.push(i + 1);
    }
  }

  if (newRows.length > 0) {
    var lastRow = todaySheet.getLastRow();
    var insertRow = lastRow > 0 ? lastRow + 1 : 2;
    
    todaySheet.getRange(insertRow, 1, newRows.length, newRows[0].length).setValues(newRows);
    
    for (var r = 0; r < rowsToMark.length; r++) {
      ordersSheet.getRange(rowsToMark[r], 10).setValue("Перенесено");
    }
    
    ui.alert("✅ Додано нових замовлень на " + targetDate + ": " + newRows.length + " шт.");
  } else {
    ui.alert("⚠️ Не знайдено нових оплачених замовлень на дату: " + targetDate);
  }
}

function sendMyOrders(chatId) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var orders = ss.getSheetByName(ORDERS_SHEET).getDataRange().getValues();
  var myOrders = [];
  
  for (var i = 1; i < orders.length; i++) {
    if (orders[i][1] == chatId) {
      var rawDate = orders[i][4];
      var date = (rawDate instanceof Date) ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd.MM") : String(rawDate).replace(/\.\d{4}/, "");
      var status = String(orders[i][9]).trim();
      var isPaid = orders[i][10] ? "✅ Оплачено" : "⏳ Очікує оплати";
      var pkg = orders[i][5];
      
      // Игнорируем старые перенесенные заказы для чистоты выдачи
      if (status !== "Перенесено" && status !== "Виконано") {
        myOrders.push(`📅 <b>${date}</b> | ${pkg}\nСтатус: ${isPaid}`);
      }
    }
  }
  
  var keyboard = [
    [{ text: "🔙 Головне меню", callback_data: "main_menu" }]
  ];

  if (myOrders.length === 0) {
    sendTelegramMessage(chatId, "У вас немає активних замовлень.", keyboard);
  } else {
    sendTelegramMessage(chatId, "<b>Ваші активні замовлення:</b>\n\n" + myOrders.join("\n\n"), keyboard);
  }
}

// quickanswer
function quickAnswer(queryId, text) {
  var payload = { callback_query_id: queryId };
  if (text) {
    payload.text = text;
    payload.show_alert = true;
  }
  fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/answerCallbackQuery", {
    method: "post", contentType: "application/json", payload: JSON.stringify(payload)
  });
}

/*function debugExternalSheet() {
  var extSS = SpreadsheetApp.openById(PROPS.getProperty('EXTERNAL_SHEET_ID'));
  var sheet = extSS.getSheetByName("23.02"); // вказати актуальну назву листа
  var data = sheet.getRange("A1:L5").getValues();
  Logger.log(JSON.stringify(data));
}*/
