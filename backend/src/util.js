import fs from 'node:fs';
import path from 'node:path';

const tails = new Map();

/**
 * Сериализует операции «прочитать → изменить → записать» по одному ключу (deviceId).
 * Без этого два параллельных webhook (или register + webhook) затирали бы друг друга в 3x-ui.
 */
export function withKeyLock(key, fn) {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/**
 * Журнал обработанных платежей (идемпотентность webhook): ЮKassa повторяет доставку при любом
 * не-200, и без журнала подписка продлевалась бы дважды. Это не база пользователей — только
 * список id платежей; источник истины по подпискам остаётся в 3x-ui.
 */
export class PaymentJournal {
  #seen = new Set();

  constructor(dir) {
    this.file = path.join(dir, 'processed-payments.log');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (line.trim()) this.#seen.add(line.trim());
      }
    }
  }

  has(key) {
    return this.#seen.has(key);
  }

  add(key) {
    if (this.#seen.has(key)) return;
    fs.appendFileSync(this.file, key + '\n');
    this.#seen.add(key);
  }
}

/**
 * Книга оплаченных платежей (JSON Lines) — по одной строке на каждое продление: когда, сколько, за что.
 * Нужна самозанятому, чтобы выписывать чеки в «Мой налог», и для сверки с реестром ЮKassa.
 * Это не база пользователей: подписки по-прежнему живут только в 3x-ui.
 */
export class PaymentLedger {
  constructor(dir) {
    this.file = path.join(dir, 'payments.jsonl');
    fs.mkdirSync(dir, { recursive: true });
  }

  record(entry) {
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }
}
