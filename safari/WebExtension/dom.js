(() => {
  'use strict';

  const rowPattern = /^([★☆])\s*(.+?)\s*\$(\d+)\s*((?:(?:Пн|Вт|Ср|Чт|Пт|Сб|Вс|сегодня|вчера|\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)\.?[,\s]*)?\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)$/iu;
  const siteIdentityPattern = /^(?:[^@]{1,240})?@\s*((\d+)__(\d+)__(\d+))\s*(?:UserId:\s*\d+)?$/iu;
  const identityPattern = /^[^@]{1,240}@\s*((\d+)__(\d+)__(\d+))\s*UserId:\s*\d+$/iu;
  const messagePattern = /^(?<author>[^@]{1,140}?)\s*@user_(?<handle>\d+)\s*(?<timestamp>\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)$/iu;
  const curatorPrefix = /^(?:(?:(?:Старший|Орг|Организационный|Предметный)[\s-]+)?Куратор|Эксперт|Ментор)(?:\s*[:–—-]\s*|\s+)/iu;
  const servicePrefix = /^(?:Разработчик|Учитель|Администратор|Менеджер|Технический специалист|Техподдержка|Модератор|Поддержка)(?=[\s:–—-]|$)/iu;
  const curatorIdentity = globalThis.ShkolkovoIdentity;
  let curatorName = null;
  const ownHandles = new Set();
  const listItemSelector = 'li, [role="listitem"]';
  const siteRowSelector = '[role="listitem"][class*="NewChat_chatListRow"]';
  const buttonSelector = 'button, [role="button"]';
  const badgePattern = /^чаты\s*[:–—-]?\s*(online|connecting|offline)$/iu;
  const badgeTitlePattern = /^чаты\s*[:–—-]?$/iu;
  const statusPattern = /^(online|connecting|offline)$/i;
  let lastIdentity = null;
  let badgeList = null;
  let badgeToolbar = null;

  const compact = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const textOf = (element) => compact(element.innerText ?? element.textContent);
  const comparable = (value) => compact(value).toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const minuteMs = 60_000;
  const recentWindow = 20 * minuteMs;
  const isRecent = (at, now = Date.now()) => Number.isFinite(at) && at <= now && now - at < recentWindow;
  const weekdays = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

  function dateAt(year, month, day, hours, minutes, seconds = 0, millis = 0, zonedLabel = '') {
    const hour = hours ?? 0;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minutes, seconds, millis));
    if (year < 2000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minutes ||
        date.getUTCSeconds() !== seconds) return null;
    if (zonedLabel) return Date.parse(zonedLabel);
    const local = new Date(year, month - 1, day, hour, minutes, seconds, millis);
    if (local.getDate() !== day || (hours !== undefined &&
        (local.getHours() !== hour || local.getMinutes() !== minutes))) return null;
    return local.getTime();
  }

  function parseTimestamp(value, now) {
    const label = comparable(value);
    const absolute = /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(z|[+-]\d{2}:\d{2})?$/iu.exec(label);
    if (absolute) {
      const [, y, m, d, h, min, s, fraction, zone] = absolute;
      const millis = Number((fraction ?? '').padEnd(3, '0'));
      const at = dateAt(+y, +m, +d, +h, +min, +(s ?? 0), millis, zone ? label : '');
      return { at, precision: s ? 'exact' : 'minute', zone };
    }
    const today = new Date(now);
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    const timed = /^(?:(пн|вт|ср|чт|пт|сб|вс|сегодня|вчера)\.?\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(label);
    if (timed) {
      const [, prefix, hour, minute, second] = timed;
      const dow = weekdays.indexOf(prefix);
      const days = dow < 0 ? Number(prefix === 'вчера') : (today.getDay() - dow + 7) % 7;
      const fromDay = daysBack => {
        const date = new Date(Date.UTC(year, month - 1, day - daysBack));
        return dateAt(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), +hour, +minute, +(second ?? 0));
      };
      let at = fromDay(days);
      if (at !== null && at > now && prefix !== 'сегодня') {
        at = fromDay(days + (dow < 0 ? 1 : 7));
      }
      return { at, precision: second ? 'exact' : 'minute' };
    }
    const dated = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?\.?[,\s]*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(label);
    if (!dated) return null;
    const [, d, m, inputYear, hour, minute, second] = dated;
    let y = inputYear ? (+inputYear < 100 ? +inputYear + 2000 : +inputYear) : year;
    if (!inputYear && (+m > month || (+m === month && +d > day))) y--;
    const at = dateAt(y, +m, +d, hour === undefined ? undefined : +hour, +(minute ?? 0), +(second ?? 0));
    return { at, precision: second ? 'exact' : hour ? 'minute' : 'day' };
  }

  const usableTime = (stamp, now) => Number.isFinite(stamp?.at) && stamp.at <= now;

  function parseActivity(value, now = Date.now()) {
    const stamp = parseTimestamp(value, now);
    return usableTime(stamp, now) ? { at: stamp.at, precision: stamp.precision } : null;
  }

  // Only use explicit DOM identifiers, never message previews, as a supplementary signal.
  function idAttribute(element, name) {
    const id = element.getAttribute(name);
    return /^[\w.:-]{1,140}$/u.test(id ?? '') ? id : null;
  }

  const timeSelector = 'time, [datetime], [title]';
  function stampWithSource(stamp, source, rejected, now) {
    const at = usableTime(stamp, now) ? stamp.at : null;
    const zone = stamp?.zone?.toLowerCase();
    const offsetMinutes = zone === 'z' ? 0 : zone
      ? (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4)))
      : Number.isFinite(stamp?.at) ? -new Date(stamp.at).getTimezoneOffset() : null;
    return { at, precision: stamp?.precision, timeParse: {
      source, at, precision: stamp?.precision, timezone: zone ? 'explicit' : 'assumed_local', offsetMinutes,
      ...(at === null ? { reason: Number.isFinite(stamp?.at) ? 'future_timestamp' : 'invalid_timestamp' } : {}),
      ...(rejected.length ? { rejected } : {})
    } };
  }

  function selectTimestamp(nodes, label, now, history = false) {
    const displayed = parseTimestamp(label, now);
    const displayedMinute = displayed?.precision !== 'day' && Number.isFinite(displayed?.at)
      ? Math.floor(displayed.at / minuteMs) * minuteMs : null;
    const rejected = [];
    for (const node of nodes) {
      if (textOf(node) !== label || !isVisible(node)) continue;
      for (const source of ['datetime', 'title']) {
        const stamp = parseTimestamp(node.getAttribute(source), now);
        if (!stamp) continue;
        const explicit = source === 'datetime' && stamp.zone;
        const sameMinute = usableTime(displayed, now) && stamp.at >= displayed.at && stamp.at < displayed.at + minuteMs;
        if (usableTime(stamp, now)) {
          if (history && explicit && stamp.precision === 'minute' && displayed?.precision === 'exact' &&
              displayed.at >= stamp.at && displayed.at < stamp.at + minuteMs) {
            return stampWithSource(displayed, 'text', rejected, now);
          }
          if (!history || explicit || (displayed?.precision === 'minute' && stamp.precision === 'exact' && sameMinute)) {
            return stampWithSource(stamp, source, rejected, now);
          }
        }
        if (stamp.precision === 'exact' && !rejected.some(item => item.source === source)) {
          const reason = !Number.isFinite(stamp.at) ? 'invalid_timestamp' : stamp.at > now ? 'future_timestamp'
            : !usableTime(displayed, now) || displayedMinute === null ? 'displayed_minute_unconfirmed'
              : stamp.at < displayedMinute || stamp.at >= displayedMinute + minuteMs ? 'displayed_minute_mismatch'
                : 'displayed_precision_preferred';
          rejected.push({ source, reason,
            deltaMs: displayedMinute !== null && Number.isFinite(stamp.at) ? stamp.at - displayedMinute : null });
        }
      }
    }
    return stampWithSource(displayed, 'text', rejected, now);
  }

  function rowStamp(row, label, now) {
    return selectTimestamp(row.querySelectorAll(timeSelector), label, now);
  }

  function isVisible(element) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
  }

  function isBold(style) {
    return style.fontWeight === 'bold' || Number(style.fontWeight) >= 600;
  }

  function* textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node;
  }

  const ownerHeading = /^(?:ответственн(?:ый|ая)(?:\s+куратор)?|назначенн(?:ый|ая)\s+куратор)(?:\s*[:—–]\s*(.*))?$/iu;
  const ownerAttrs = ['data-assignee-name', 'data-responsible-name'];
  const ownerSelector = '[data-assignee-name], [data-responsible-name], [aria-label], [title], dt, label, [role="status"]';

  function setCuratorName(name) {
    if (name === curatorName) return;
    curatorName = name;
    ownHandles.clear();
  }

  function isKnownOwnHandle(handle) {
    return ownHandles.size === 1 && ownHandles.has(handle);
  }

  function isOwnAssignment(value) {
    const name = comparable(value).replace(curatorPrefix, '');
    if (/^(?:нет|не назначен[а]?|не указан[а]?|[—–-])$/u.test(name)) return false;
    if (!curatorName) return undefined;
    const handle = /^@user_(\d+)$/u.exec(name)?.[1];
    if (handle) return ownHandles.size === 1 ? isKnownOwnHandle(handle) : undefined;
    if (curatorIdentity.matches(name, curatorName)) return true;
    if (!/^[\p{L}\p{M}'’\-]+(?:\s+[\p{L}\p{M}'’\-]+){1,2}$/u.test(name)) return undefined;
    const parts = curatorIdentity.key(name).split(' ');
    const ownParts = curatorIdentity.key(curatorName).split(' ');
    // An extra name component could be a patronymic.
    return ownParts.every(part => parts.includes(part)) ? undefined : false;
  }

  // Read an explicitly labelled metadata field, never infer ownership from the
  // selected account, a message author, or a line of message/preview text.
  function assignmentField(root, label) {
    const evidence = new Set();
    const omitted = new Set();
    function record(value, field) {
      evidence.add(isOwnAssignment(value));
      if (field !== root && !/[$★☆]/u.test(textOf(field))) omitted.add(field);
    }
    for (const field of [root, ...root.querySelectorAll(ownerSelector)]) {
      if (!isVisible(field)) continue;
      for (const attr of ownerAttrs) {
        const value = field.getAttribute(attr);
        if (value !== null) record(value || 'не назначен', field);
      }
      for (const attr of ['aria-label', 'title']) {
        const heading = ownerHeading.exec(compact(field.getAttribute(attr)));
        if (heading) record(heading[1] || textOf(field), field);
      }
      if (field.tagName === 'LABEL' || field.getAttribute('role') === 'status') {
        const heading = ownerHeading.exec(textOf(field));
        if (heading?.[1]) record(heading[1], field);
      }
      if (field.tagName === 'DT' && ownerHeading.test(textOf(field))) {
        const item = field.nextElementSibling;
        if (item?.tagName === 'DD' && isVisible(item)) {
          omitted.add(field);
          record(textOf(item), item);
        }
      }
    }
    // Keep the original row title and ID when a labelled assignee badge is displayed.
    // Remove by node boundaries: the assignee and student may have identical names.
    let clean = label;
    if (omitted.size) {
      const nodes = [];
      for (const node of textNodes(root)) {
        let part = node.parentElement;
        while (part && part !== root && !omitted.has(part)) part = part.parentElement;
        if (part === root) nodes.push(node.data);
      }
      clean = compact(nodes.join(' '));
    }
    return { clean, assignedToSelf: evidence.size === 1 ? [...evidence][0] : undefined };
  }

  function titleElement(row, label, course) {
    const candidates = [label, `${label} $${course}`, `${label}$${course}`];
    for (const node of textNodes(row)) {
      if (candidates.includes(compact(node.data))) return node.parentElement;
    }

    return Array.from(row.querySelectorAll('*')).reverse()
      .find((element) => candidates.includes(textOf(element))) ?? row;
  }

  function selectedState(title, row) {
    for (let element = title; element; element = element.parentElement) {
      const selected = element.getAttribute('aria-selected');
      if (selected === 'true' || selected === 'false') return selected === 'true';

      const current = element.getAttribute('aria-current');
      if (current && current !== 'false') return true;
      if (Array.from(element.classList).some((name) => /(?:^|[-_])(?:selected|active|current)$/i.test(name))) return true;
      if (element === row) break;
    }
    if (siteRow(row)) return /rgba\(\s*24,\s*144,\s*255,\s*0\.15\s*\)/u.test(row.style?.background || row.getAttribute('style') || '');
    return null;
  }

  const siteRow = row => Array.from(row.classList).some(name => name.startsWith('NewChat_chatListRow'));
  const domPosition = (element, name) => {
    const value = Number(element.getAttribute(name));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };

  function getVirtualList() {
    const row = Array.from(document.querySelectorAll(siteRowSelector)).find(isVisible);
    return row?.closest('[role="list"]') ?? null;
  }

  function layoutRowKey(element) {
    const rowId = idAttribute(element, 'data-chat-id') || idAttribute(element, 'data-conversation-id');
    if (rowId) return 'id:' + rowId;
    const header = /^[★☆]\s*(.+?)\s*\$(\d+)\b/u.exec(assignmentField(element, textOf(element)).clean);
    return header ? `${header[2]}:${comparable(header[1])}` : null;
  }

  function getListLayout(root, rows, identifyUnknown = false) {
    const byElement = new Map(rows.map(row => [row.rowElement, row.key]));
    const positions = [];
    const sizes = new Set();
    for (const element of root.querySelectorAll(siteRowSelector)) {
      if (!isVisible(element)) continue;
      const position = domPosition(element, 'aria-posinset');
      const size = domPosition(element, 'aria-setsize');
      const top = /translateY\((-?[\d.]+)px\)/u.exec(element.style?.transform || element.getAttribute('style') || '');
      if (size) sizes.add(size);
      const key = byElement.get(element) ?? (identifyUnknown ? layoutRowKey(element) : null);
      positions.push({ position, key, top: top ? Number(top[1]) : null });
    }
    return { total: sizes.size === 1 ? [...sizes][0] : null, positions };
  }

  function getRows(listRoot = document, now = Date.now(), ambiguousFallbacks = null) {
    const rows = new Map();
    const ambiguous = new Set();
    const virtual = listRoot === document ? getVirtualList() : null;
    for (const row of (virtual || listRoot).querySelectorAll(virtual ? siteRowSelector : listItemSelector)) {
      if (!isVisible(row)) continue;
      const assignment = assignmentField(row, textOf(row));
      const match = rowPattern.exec(assignment.clean);
      if (!match) continue;

      const [, star, rawLabel, course, activity] = match;
      const label = rawLabel.trim();
      if (!/\p{L}/u.test(label)) continue;
      const pinned = star === '★';

      const rowId = idAttribute(row, 'data-chat-id') || idAttribute(row, 'data-conversation-id');
      const fallbackKey = `${course}:${comparable(label)}`;
      const key = rowId ? 'id:' + rowId : fallbackKey;
      if (rows.has(key)) {
        ambiguous.add(key);
        if (!rowId && ambiguousFallbacks) ambiguousFallbacks.set(key, (ambiguousFallbacks.get(key) ?? 1) + 1);
        continue;
      }

      const element = titleElement(row, label, course);
      const style = getComputedStyle(element);
      const unread = isBold(style) && /^(?:italic|oblique)\b/u.test(style.fontStyle);
      const stamp = rowStamp(row, activity, now);
      rows.set(key, { key, rowId, fallbackKey, label, activity, ...stamp, signal: idAttribute(row, 'data-last-message-id'),
        assignedToSelf: assignment.assignedToSelf, unread, pinned, selected: selectedState(element, row), course, element, rowElement: row,
        position: domPosition(row, 'aria-posinset') });
    }

    return Array.from(rows.values()).filter((row) => !ambiguous.has(row.key));
  }

  function getListRoot(rows) {
    const elements = Array.from(rows.values(), row => row.rowElement);
    const first = elements[0];
    if (!first) return null;

    for (let node = first.parentElement; node && node !== document.body; node = node.parentElement) {
      const tag = (node.tagName ?? '').toUpperCase();
      if (tag !== 'UL' && tag !== 'OL' && node.getAttribute('role') !== 'list') continue;
      if (elements.every(element => node.contains(element))) return node;
    }
    return null;
  }

  function siblingLabel(node) {
    if (node.nodeType === 3) return compact(node.nodeValue);
    return node.nodeType === 1 && isVisible(node) ? textOf(node) : '';
  }

  function meaningfulSibling(node, direction) {
    for (let sibling = node[direction]; sibling; sibling = sibling[direction]) {
      const label = siblingLabel(sibling);
      if (label) return { node: sibling, label };
    }
    return null;
  }

  function badgeBefore(list) {
    for (let anchor = list, level = 0; anchor && level < 3; anchor = anchor.parentElement, level += 1) {
      const root = anchor.parentElement;
      if (!root || root === document.body || root === document.documentElement) break;
      const nearest = meaningfulSibling(anchor, 'previousSibling');
      if (!nearest) continue;
      const combined = badgePattern.exec(nearest.label);
      if (combined || badgeTitlePattern.test(nearest.label)) {
        return { root, status: combined?.[1].toLowerCase() ?? null, heading: nearest.node };
      }
      const status = statusPattern.exec(nearest.label);
      if (!status) continue;
      const heading = meaningfulSibling(nearest.node, 'previousSibling');
      if (heading && badgeTitlePattern.test(heading.label)) {
        return { root, status: status[1].toLowerCase(), heading: heading.node };
      }
    }
    return null;
  }

  function buttonHasLabel(button, label) {
    const elements = [button, ...button.querySelectorAll('[aria-label], [title], img[alt]')];
    return elements.some(element => ['aria-label', 'title', 'alt'].some(attribute =>
      compact(element.getAttribute(attribute)).toLowerCase() === label));
  }

  function isChatToolbar(node) {
    if (node?.nodeType !== 1 || !isVisible(node)) return false;
    const buttons = Array.from(node.querySelectorAll(buttonSelector));
    return buttons.some(button => buttonHasLabel(button, 'search')) &&
      buttons.some(button => buttonHasLabel(button, 'ellipsis'));
  }

  function badgeAfter(toolbar) {
    const title = meaningfulSibling(toolbar, 'nextSibling');
    if (!title) return null;
    const combined = badgePattern.exec(title.label);
    if (combined) return { root: toolbar.parentElement, status: combined[1].toLowerCase() };
    if (!badgeTitlePattern.test(title.label)) return null;
    const indicator = meaningfulSibling(title.node, 'nextSibling');
    const status = statusPattern.exec(indicator?.label ?? '');
    return { root: toolbar.parentElement, status: status?.[1].toLowerCase() ?? null };
  }

  function getConnectionBadge(listRoot) {
    for (const list of new Set([listRoot, badgeList])) {
      if (!list?.isConnected) continue;
      const badge = badgeBefore(list);
      if (!badge || lastIdentity?.root.contains(badge.root)) continue;
      badgeList = list;
      const toolbar = badge.heading.previousElementSibling;
      if (isChatToolbar(toolbar)) badgeToolbar = toolbar;
      return { root: badge.root, status: badge.status };
    }

    if (badgeToolbar?.isConnected) {
      const known = badgeAfter(badgeToolbar);
      if (known) return known;
    }

    // When the list has no rows or is being mounted, require the two observed toolbar controls.
    for (const button of document.querySelectorAll(buttonSelector)) {
      if (!buttonHasLabel(button, 'search')) continue;
      for (let toolbar = button.parentElement, level = 0; toolbar && level < 3;
        toolbar = toolbar.parentElement, level += 1) {
        const root = toolbar.parentElement;
        if (!root || root === document.body || root === document.documentElement) break;
        if (!isChatToolbar(toolbar) || lastIdentity?.root.contains(root)) continue;
        const badge = badgeAfter(toolbar);
        if (!badge) continue;
        badgeToolbar = toolbar;
        return badge;
      }
    }
    return null;
  }

  function hasLoadedEmptyList() {
    const sidebar = getConnectionBadge(null)?.root;
    if (!sidebar || Array.from(sidebar.querySelectorAll('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning')).some(isVisible)) return false;
    for (const node of textNodes(sidebar)) {
      if (/^(?:нет чатов|чатов (?:пока )?нет|у вас (?:пока )?нет чатов)[.!]?$/iu.test(compact(node.data)) && isVisible(node.parentElement)) return true;
    }
    return false;
  }

  function getRowActivity({ rowElement, key }) {
    if (!rowElement?.isConnected) return null;
    const match = rowPattern.exec(assignmentField(rowElement, textOf(rowElement)).clean);
    const id = idAttribute(rowElement, 'data-chat-id') || idAttribute(rowElement, 'data-conversation-id');
    if (!match || (id ? 'id:' + id : `${match[3]}:${comparable(match[2])}`) !== key) return null;
    return match[4];
  }

  function isRowUnread({ element }) {
    if (!element?.isConnected) return null;
    const style = getComputedStyle(element);
    return isBold(style) && /^(?:italic|oblique)\b/u.test(style.fontStyle);
  }

  function findIdentity(composer) {
    if (lastIdentity?.composer === composer && lastIdentity.root.contains(composer) &&
        lastIdentity.root.contains(lastIdentity.identity) && lastIdentity.label === textOf(lastIdentity.identity)) {
      return lastIdentity;
    }

    const siteHeader = document.querySelector?.('.planName');
    if (siteHeader) {
      const label = textOf(siteHeader);
      const match = siteIdentityPattern.exec(label);
      const root = siteHeader.parentElement;
      if (!match || !root?.contains(composer) || !isVisible(siteHeader)) return null;
      const [, id, , course, studentHandle] = match;
      lastIdentity = { composer, root, identity: siteHeader, id, course, studentHandle, label };
      return lastIdentity;
    }

    for (const node of textNodes(document.body)) {
      if (!/\d+__\d+__\d+/u.test(node.data)) continue;
      let identity = node.parentElement;
      for (let level = 0; identity && level < 5; level += 1, identity = identity.parentElement) {
        if (identity.contains(composer)) break;
        const label = textOf(identity);
        const match = identityPattern.exec(label) || identityPattern.exec(assignmentField(identity, label).clean);
        if (!match || !isVisible(identity)) continue;
        const [, id, , course, studentHandle] = match;

        let root = composer.parentElement;
        while (root && !root.contains(identity)) root = root.parentElement;
        if (root && root !== document.body && root !== document.documentElement) {
          lastIdentity = { composer, root, identity, id, course, studentHandle, label };
          return lastIdentity;
        }
        break;
      }
    }
    lastIdentity = null;
    return null;
  }

  function classify(author, handle, studentHandle) {
    if (servicePrefix.test(author)) return 'service';
    if (curatorPrefix.test(author)) {
      if (handle === studentHandle) return 'unknown';
      if (curatorName && curatorIdentity.matches(author.replace(curatorPrefix, ''), curatorName)) {
        if (ownHandles.size < 2) ownHandles.add(handle);
        return 'own';
      }
      return 'curator';
    }
    if (handle === studentHandle) return 'student';
    if (isKnownOwnHandle(handle)) return 'own';
    return 'unknown';
  }

  function needsReply(text) {
    const value = comparable(text);
    if (!value || /[?？]/u.test(value)) return true;
    const pictographs = /[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}][\uFE0E\uFE0F\u200D]*/gu;
    const words = value.replace(pictographs, ' ').replace(/\p{P}+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!words) return false;
    return !/^(?:(?:спасибо(?:\s+(?:вам|большое|огромное)){0,2}|(?:большое|огромное) спасибо|благодарю(?: вас)?|(?:(?:все|теперь|тогда)\s+)?(?:понял[аи]?|понятно|ясно)|хорошо|ладно|ок(?:ей)?|да|ага|супер|отлично)(?:\s+|$)){1,4}$/u.test(words);
  }

  function messageStamp(root, label, now = Date.now()) {
    return selectTimestamp(root ? [root, ...root.querySelectorAll(timeSelector)] : [], label, now, true);
  }

  function readSiteHistory(conversation) {
    const history = conversation.root.querySelector?.('#scroll');
    if (!history) return null;
    const children = Array.from(history.children);
    const holders = children.filter(element => element.id?.startsWith('message-'));
    if (!holders.length) return { entries: [], settled: false };
    const seen = new Set();
    const entries = [];
    for (const holder of holders) {
      const id = idAttribute(holder, 'id')?.slice('message-'.length);
      const author = textOf(holder.querySelector('[class*="messegeInfo_name"]') || {});
      const handle = /^@user_(\d+)$/u.exec(textOf(holder.querySelector('[class*="messegeInfo_info"]') || {}))?.[1];
      const timeNode = holder.querySelector('[class*="messegeInfo_time"]');
      const timestamp = textOf(timeNode || {});
      const stamp = messageStamp(timeNode, timestamp);
      if (!id || seen.has(id)) return { entries: [], settled: false };
      if (!Number.isFinite(stamp.at)) return { entries: [], settled: false, invalidTime: stamp.timeParse };
      seen.add(id);
      // The author and timestamp are present even when the reply is only an emoji.
      const kind = author && handle ? classify(author, handle, conversation.studentHandle) : 'unknown';
      const message = { id, author, time: stamp.at, precision: stamp.precision, timeParse: stamp.timeParse, timestamp, kind };
      if (kind === 'student') {
        const attachment = holder.querySelector('[class*="NewChat_chat__messegeImg"], [class*="attachment"], a[download]');
        const body = holder.querySelector('[class*="messegeText"]');
        if (body || attachment) {
          const emojiLabels = Array.from(body?.querySelectorAll('img[alt]') ?? [], image => image.getAttribute('alt')).join(' ');
          message.requiresReply = Boolean(attachment) || needsReply(textOf(body || {}) || emojiLabels);
        }
      }
      entries.push({ element: holder, message });
    }
    // The chat bundle renders a paging button or a spinner directly before the
    // first message whenever more history can be loaded or is loading.
    const beforeMessages = children.slice(0, children.indexOf(holders[0]));
    const settled = !beforeMessages.some(element => element.matches?.('.ant-spin, [aria-busy="true"], [role="progressbar"]') ||
      element.querySelector?.('.ant-spin, [aria-busy="true"], [role="progressbar"]'));
    return { entries, settled };
  }

  function isMessageMetadata(header, author, handle, timestamp) {
    const parts = new Set();
    let hasBoldAuthor = false;
    for (const element of header.querySelectorAll('*')) {
      const text = textOf(element);
      if (text === author && isBold(getComputedStyle(element))) hasBoldAuthor = true;
      parts.add(text);
    }
    const handleText = `@user_${handle}`;
    const hasSeparateDetails = parts.has(handleText) && parts.has(timestamp);
    const hasCombinedDetails = parts.has(`${handleText} ${timestamp}`) || parts.has(`${handleText}${timestamp}`);
    return parts.has(author) && (hasSeparateDetails || (hasBoldAuthor && hasCombinedDetails));
  }

  function findHeader(node, conversation) {
    let element = node.parentElement;
    for (let level = 0; element && element !== conversation.root && level < 5; level += 1, element = element.parentElement) {
      const match = messagePattern.exec(textOf(element));
      if (!match || !isVisible(element)) continue;
      const { author: rawAuthor, handle, timestamp } = match.groups;
      const author = rawAuthor.trim();
      if (!isMessageMetadata(element, author, handle, timestamp)) continue;

      const stamp = messageStamp(element, timestamp);
      if (!Number.isFinite(stamp.at)) return null;
      const holder = element.closest?.('[data-message-id]');
      const id = holder && conversation.root.contains(holder) ? idAttribute(holder, 'data-message-id') : null;
      return { element, message: { ...(id ? { id } : {}), author, time: stamp.at, precision: stamp.precision,
        timeParse: stamp.timeParse, timestamp,
        kind: classify(author, handle, conversation.studentHandle) } };
    }
    return null;
  }

  function getChat(recordInvalidTime) {
    const composer = document.getElementById('chat-text-input');
    if (!composer || !isVisible(composer)) return null;
    const conversation = findIdentity(composer);
    if (!conversation) return null;

    const { root, identity, id, course } = conversation;
    if (Array.from(root.querySelectorAll('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning'))
        .some(isVisible)) return null;
    const site = readSiteHistory(conversation);
    if (site && !site.settled) {
      if (site.invalidTime) recordInvalidTime?.(site.invalidTime, id);
      return null;
    }
    const seenHeaders = new Set();
    const entries = site?.entries ?? [];
    const markers = [];
    for (const node of site ? [] : textNodes(root)) {
      if (identity.contains(node) || composer.contains(node)) continue;
      if (!(identity.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      // A standalone metadata timestamp without a parseable author must not disappear
      // from history. An ambiguous entry can change both the last author and occupancy.
      const timestamp = /^(?:@user_\d+\s*)?(\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)$/iu.exec(compact(node.data));
      if (timestamp && isVisible(node.parentElement)) markers.push({ node, label: timestamp[1] });
      if (!/@user_\d+/iu.test(node.data)) continue;
      const header = findHeader(node, conversation);
      if (!header || seenHeaders.has(header.element)) continue;
      seenHeaders.add(header.element);
      entries.push(header);
    }
    const belongsToHeader = node => {
      for (let p = node.parentElement; p && p !== root; p = p.parentElement) if (seenHeaders.has(p)) return true;
      return false;
    };
    for (const { node, label } of markers) {
      if (belongsToHeader(node)) continue;
      const stamp = messageStamp(node.parentElement, label);
      if (!Number.isFinite(stamp.at)) {
        recordInvalidTime?.(stamp.timeParse, id);
        return null;
      }
      entries.push({ element: node.parentElement,
        message: { author: '', time: stamp.at, precision: stamp.precision, timeParse: stamp.timeParse, kind: 'unknown' } });
    }
    // When the interface exposes message containers, a visible container without
    // any timestamp has an unknown position in the two-hour window.
    for (const holder of root.querySelectorAll('[data-message-id]')) {
      if (isVisible(holder) && !entries.some(e => holder.contains(e.element))) return null;
    }
    entries.sort((a, b) => a.element === b.element ? 0 :
      a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const messages = entries.map(e => e.message);
    let earliest = -Infinity;
    for (const { time, precision } of messages) {
      earliest = Math.max(earliest, time);
      const latest = precision === 'day' ? new Date(time).setHours(24, 0, 0, 0) - 1
        : time + (precision === 'minute' ? minuteMs - 1 : 0);
      if (latest < earliest) return null;
    }
    const paging = Array.from(root.querySelectorAll('button, [role="button"]')).filter(element =>
      /^(?:загрузить\s+ещ[её]|(?:показать|загрузить)\s+(?:предыдущие|ранние)\s+сообщения)$/iu.test(textOf(element)));
    const loadMore = paging.find(element => isVisible(element) && !element.disabled);
    const moreExpected = paging.length > 0 || Boolean(root.querySelector?.('[data-has-more="true"]'));
    // A short list without a visible paging button may still be a virtualized slice.
    // Only site metadata or a service marker above the first message confirms the start.
    const first = entries[0]?.element;
    const boundaryNodes = root.querySelectorAll('[data-has-more="false"], [data-history-start="true"], [role="separator"], [role="status"], .ant-divider');
    function marksBeginning(el) {
      if (!isVisible(el)) return false;
      if (el.getAttribute('data-has-more') === 'false' && el.contains(first)) return true;
      if (!(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) ||
          entries.some(entry => el.contains(entry.element))) return false;
      return el.getAttribute('data-history-start') === 'true' ||
        /^(?:начало (?:переписки|чата|диалога)|больше сообщений нет)$/iu.test(textOf(el));
    }
    const historyComplete = Boolean(first && !moreExpected && (site?.settled || root.getAttribute('data-has-more') === 'false' ||
      first.closest?.('[aria-posinset="1"][aria-setsize]') || Array.from(boundaryNodes).some(marksBeginning)));
    const latestStudent = messages.findLast((message) => message.kind === 'student') ?? null;
    const header = identity.closest?.('header, [role="banner"]');
    const metadata = header && root.contains(header) && !header.contains(composer) ? header : identity;
    const { assignedToSelf } = assignmentField(metadata, textOf(metadata));
    return { id, course, studentName: latestStudent?.author ?? null, latestStudent, messages, historyComplete, moreExpected, loadMore, assignedToSelf };
  }

  globalThis.ShkolkovoDom = { getRows, getListRoot, getVirtualList, getListLayout, getConnectionBadge, getRowActivity,
    isRowUnread, getChat, parseActivity, hasLoadedEmptyList, recentWindow, isRecent, setCuratorName };
})();
