(() => {
  'use strict';

  function clean(value) {
    return typeof value === 'string' ? value.normalize('NFKC').trim()
      .replace(/\s+/gu, ' ').replace(/[‐‑‒–—−]/gu, '-').replace(/’/gu, "'") : '';
  }

  function parse(fields) {
    const first = clean(fields?.firstName);
    const last = clean(fields?.lastName);
    const valid = part => part.length <= 60 && /^\p{L}[\p{L}\p{M}]*(?:[ '\-]\p{L}[\p{L}\p{M}]*)*$/u.test(part);
    return valid(first) && valid(last) ? first + ' ' + last : null;
  }

  function key(name) {
    return clean(name).toLocaleLowerCase('ru').replaceAll('ё', 'е').split(' ').sort().join(' ');
  }

  function matches(left, right) {
    const first = key(left);
    return Boolean(first && first === key(right));
  }

  globalThis.ShkolkovoIdentity = { parse, key, matches };
})();
