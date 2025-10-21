// --- Константы ---
var SHEET_ID = "your_sheet_id";
var CLIENTS_SHEET = "Info";
var TODAY_SHEET = "Today";
var LOGS_SHEET = "Logs";
var TOKEN = "your_bot_token";
var TEST_CHAT_ID = your_telegram_id;

// Колонки (1-based для удобства, в коде используем -1 при индексировании массивов)
var PHONE_COL = 3;          // C
var CHAT_COL = 5;           // E
var NOTE_COL = 7;           // G
var GENERAL_NOTE_COL = 8;   // H (общая заметка — только в H2)
var DELIVERY_TIME_COL = 6;  // F

// Админы
var ADMIN_CHAT_IDS = [your_telegram_id];

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
  var inlineKeyboard_ok = [[{ text: "Змінити номер телефону", callback_data: "change_yes" }]];
  var inlineKeyboard_again = [[{ text: "Ввести інший номер", callback_data: "change_yes" }]];

  var bindResult = bindChatId(phone, chatId);

  switch(bindResult) {
    case "ok": sendTelegramMessage(chatId, `✅ Ваш чат успішно прив'язано до номера: ${phone}`, inlineKeyboard_ok); break;
    case "already": sendTelegramMessage(chatId,"❌ Цей номер вже прив'язаний до іншого акаунту.\nЯкщо хочете прив'язати інший номер, натисніть кнопку нижче:",inlineKeyboard_again); break;
    case "not_found": sendTelegramMessage(chatId,"❌ Вас немає у списку клієнтів. Перевірте номер або зверніться до адміністратора.",inlineKeyboard_again); break;
    case "invalid":
    default: sendTelegramMessage(chatId,"❌ Невірний номер. Спробуйте дійсний український мобільний номер 📞 (наприклад 0XXXXXXXXX або +380XXXXXXXXX)",inlineKeyboard_again); break;
  }

  clearUserStatus(chatId);
}

// --- Webhook (doPost) ---
function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var chatId = data.message?.chat?.id || data.callback_query?.message?.chat?.id;
  var text = (data.message?.text || "").trim();
  var callbackData = data.callback_query?.data;

  if (!chatId) return ContentService.createTextOutput("ok");

  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(CLIENTS_SHEET);

  // Админ-команды
  if (ADMIN_CHAT_IDS.includes(chatId) && text) {
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
    }
  }

  // Callback кнопки
  if (callbackData) {
    if (callbackData === "change_yes") {
      setUserStatus(chatId, "waiting_for_phone");
      sendTelegramMessage(chatId, "Введіть новий номер телефону у форматі 0XXXXXXXXX або +380XXXXXXXXX 📞:");
    } else if (callbackData === "change_no") {
      var clients = sheet.getDataRange().getValues();
      var existingIndexes = [];
      for (var i = 1; i < clients.length; i++) if (clients[i][CHAT_COL-1] == chatId) existingIndexes.push(i);
      var currentPhone = existingIndexes.length ? clients[existingIndexes[0]][PHONE_COL-1] || "невідомий" : "невідомий";
      var inlineKeyboard = [[{ text: "Змінити номер телефону", callback_data: "change_yes" }]];
      sendTelegramMessage(chatId, `Ваш номер залишився без змін ✅\nНомер: ${currentPhone}`, inlineKeyboard);
    }
    fetchWithRetry("https://api.telegram.org/bot" + TOKEN + "/answerCallbackQuery", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ callback_query_id: data.callback_query.id })
    });
    return ContentService.createTextOutput("ok");
  }

  // Пользовательская логика
  var clients = sheet.getDataRange().getValues();
  var existingIndexes = [];
  for (var i = 1; i < clients.length; i++) if (clients[i][CHAT_COL-1] == chatId) existingIndexes.push(i);

  if (text === "/start") {
    if (existingIndexes.length) {
      clearUserStatus(chatId);
      var currentPhone = clients[existingIndexes[0]][PHONE_COL-1] || "невідомий";
      var inlineKeyboard = [[{ text: "Змінити номер телефону", callback_data: "change_yes" }]];
      sendTelegramMessage(chatId, `Ви вже прив'язані до акаунту.\nВаш номер: ${currentPhone}`, inlineKeyboard);
    } else {
      sendTelegramMessage(chatId, "Привіт! Введіть свій номер телефону у форматі 0XXXXXXXXX або +380XXXXXXXXX 📞");
    }
    return ContentService.createTextOutput("ok");
  }

  if (existingIndexes.length && getUserStatus(chatId) === "waiting_for_phone") {
    handlePhoneInput(chatId, text);
    return ContentService.createTextOutput("ok");
  }

  if (existingIndexes.length) {
    var currentPhone = clients[existingIndexes[0]][PHONE_COL-1] || "невідомий";
    var inlineKeyboard = [[{ text: "Змінити номер телефону", callback_data: "change_yes" }]];
    sendTelegramMessage(chatId, `Ви вже прив'язані до акаунту.\nВаш номер: ${currentPhone}`, inlineKeyboard);
    return ContentService.createTextOutput("ok");
  }

  if (existingIndexes.length === 0 && text) {
    handlePhoneInput(chatId, text);
    return ContentService.createTextOutput("ok");
  }

  return ContentService.createTextOutput("ok");
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


// --- UI меню ---
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Delivery')
    .addItem('Відправити сьогоднішні нотатки', 'sendNotesToday')
    .addItem('Відправити сьогоднішній час доставки', 'sendTodayNow')
    .addItem('Відправити ВСЕ (час доставки + персональні та загальні нотатки)', 'sendAllToday')
    .addSeparator()
    .addItem('Попередній перегляд повідомлень', 'previewTodayMessages')
    .addItem('Тестова розсилка на мій чат', 'sendTestToday')
    .addToUi();
}
