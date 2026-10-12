import net from 'node:net';

/** IP-адреса, с которых ЮKassa шлёт уведомления: https://yookassa.ru/developers/using-api/webhooks */
const YOOKASSA_CIDRS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32',
];

function v4ToBigInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
}

function v6ToBigInt(ip) {
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

function parseCidr(cidr) {
  const [addr, bitsStr] = cidr.split('/');
  const family = net.isIPv6(addr) ? 6 : 4;
  const total = family === 6 ? 128 : 32;
  const bits = Number(bitsStr);
  const base = family === 6 ? v6ToBigInt(addr) : v4ToBigInt(addr);
  const shift = BigInt(total - bits);
  return { family, shift, prefix: base >> shift };
}

const RANGES = YOOKASSA_CIDRS.map(parseCidr);

/** '::ffff:185.71.76.5' (так отдаёт Node для IPv4 на dual-stack сокете) → '185.71.76.5'. */
export function normalizeIp(ip) {
  return typeof ip === 'string' ? ip.replace(/^::ffff:/i, '') : '';
}

export function isYooKassaIp(rawIp) {
  const ip = normalizeIp(rawIp);
  const family = net.isIP(ip);
  if (!family) return false;
  const value = family === 6 ? v6ToBigInt(ip) : v4ToBigInt(ip);
  if (value === null) return false;
  return RANGES.some((r) => r.family === family && value >> r.shift === r.prefix);
}
