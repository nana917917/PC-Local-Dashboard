'use strict';

// 接続元の判定。
// 「家庭内LAN」は広いCIDRを決め打ちせず、このPCの実際のネットワーク
// インターフェース（IPアドレスとサブネットマスク）から求めた同一サブネットだけを許可する。
// 追加で許可したいネットワークは設定（lanAllowedNetworks）で明示的に指定する。

const os = require('node:os');

// 仮想アダプター（WSL・Hyper-V等）は既定では許可しない。
// 実機のWi-Fi／Ethernetを対象にすることで、意図しない経路からの接続を減らす。
const VIRTUAL_INTERFACE_PATTERN = /(vethernet|hyper-v|wsl|docker|vmware|virtualbox|loopback|bluetooth|tap|tun|tailscale|zerotier|npcap|radmin|hamachi)/i;

function normalizeAddress(address) {
  return String(address || '').replace(/^::ffff:/i, '').split('%')[0].trim().toLowerCase();
}

function isLoopbackAddress(address) {
  const value = normalizeAddress(address);
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function ipv4ToInt(address) {
  const parts = normalizeAddress(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

// '192.168.1.5' + '255.255.255.0' からネットワーク範囲を作る
function ipv4Network(address, netmask) {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip === null || mask === null) return null;
  const base = (ip & mask) >>> 0;
  const prefix = mask.toString(2).split('').filter((bit) => bit === '1').length;
  if (prefix < 8 || prefix > 32) return null;
  return { family: 'ipv4', base, mask: mask >>> 0, prefix, cidr: `${intToIpv4(base)}/${prefix}` };
}

function ipv4InNetwork(address, network) {
  const ip = ipv4ToInt(address);
  if (ip === null || !network || network.family !== 'ipv4') return false;
  return ((ip & network.mask) >>> 0) === network.base;
}

function ipv6ToBytes(address) {
  const value = normalizeAddress(address);
  if (!value.includes(':')) return null;
  const [head, tail] = value.split('::');
  const headParts = head ? head.split(':').filter((part) => part !== '') : [];
  const tailParts = tail ? tail.split(':').filter((part) => part !== '') : [];
  if (headParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || tailParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (missing > 0 && !value.includes('::'))) return null;
  const groups = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const number = parseInt(group, 16);
    if (!Number.isFinite(number)) return;
    bytes[index * 2] = (number >> 8) & 255;
    bytes[index * 2 + 1] = number & 255;
  });
  return bytes;
}

function ipv6PrefixFromMask(mask) {
  const bytes = ipv6ToBytes(mask);
  if (!bytes) return null;
  let prefix = 0;
  for (const byte of bytes) {
    if (byte === 255) { prefix += 8; continue; }
    let value = byte;
    while (value & 0x80) { prefix += 1; value = (value << 1) & 255; }
    break;
  }
  return prefix;
}

function ipv6Network(address, netmask) {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return null;
  const prefix = netmask ? ipv6PrefixFromMask(netmask) : 64;
  if (prefix === null || prefix < 1 || prefix > 128) return null;
  return { family: 'ipv6', bytes, prefix, cidr: `${normalizeAddress(address)}/${prefix}` };
}

function ipv6InNetwork(address, network) {
  const bytes = ipv6ToBytes(address);
  if (!bytes || !network || network.family !== 'ipv6') return false;
  const fullBytes = Math.floor(network.prefix / 8);
  const remainingBits = network.prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== network.bytes[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 255;
  return (bytes[fullBytes] & mask) === (network.bytes[fullBytes] & mask);
}

// '192.168.1.0/24' 形式の文字列を解釈する（設定の追加許可ネットワーク用）
function parseNetwork(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const [address, prefixText] = value.split('/');
  if (address.includes(':')) {
    const bytes = ipv6ToBytes(address);
    if (!bytes) return null;
    const prefix = prefixText === undefined ? 64 : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
    return { family: 'ipv6', bytes, prefix, cidr: `${normalizeAddress(address)}/${prefix}` };
  }
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) return null;
  const ip = ipv4ToInt(address);
  if (ip === null) return null;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return { family: 'ipv4', base: (ip & mask) >>> 0, mask, prefix, cidr: `${intToIpv4((ip & mask) >>> 0)}/${prefix}` };
}

function normalizeNetworkList(value, limit = 8) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
  const seen = new Set();
  const networks = [];
  for (const item of source) {
    const network = parseNetwork(item);
    if (!network) continue;
    if (seen.has(network.cidr)) continue;
    seen.add(network.cidr);
    networks.push(network);
    if (networks.length >= limit) break;
  }
  return networks;
}

// このPCが実際に接続しているネットワーク（同じサブネット）を列挙する
function collectLocalNetworks(networkInterfaces = os.networkInterfaces(), options = {}) {
  const includeVirtual = Boolean(options.includeVirtual);
  const networks = [];
  for (const [name, addresses] of Object.entries(networkInterfaces || {})) {
    const virtual = VIRTUAL_INTERFACE_PATTERN.test(name);
    for (const entry of addresses || []) {
      if (entry.internal) continue;
      const family = (entry.family === 'IPv4' || entry.family === 4) ? 'ipv4'
        : (entry.family === 'IPv6' || entry.family === 6) ? 'ipv6' : null;
      if (!family) continue;
      if (virtual && !includeVirtual) continue;
      if (family === 'ipv4' && normalizeAddress(entry.address).startsWith('169.254.')) continue;
      const network = family === 'ipv4'
        ? ipv4Network(entry.address, entry.netmask)
        : ipv6Network(entry.address, entry.netmask);
      if (!network) continue;
      networks.push({ ...network, interfaceName: name, address: entry.address, virtual });
    }
  }
  return networks;
}

function matchNetworks(address, networks) {
  for (const network of networks) {
    if (network.family === 'ipv4' && ipv4InNetwork(address, network)) return network;
    if (network.family === 'ipv6' && ipv6InNetwork(address, network)) return network;
  }
  return null;
}

// 許可判定。loopback は常に許可。それ以外は「このPCと同じサブネット」だけを許可する。
function evaluateAccess(address, networks, extraNetworks = []) {
  const value = normalizeAddress(address);
  if (isLoopbackAddress(value)) return { allowed: true, kind: 'local', matched: 'loopback' };
  const matched = matchNetworks(value, networks) || matchNetworks(value, extraNetworks);
  if (matched) {
    return {
      allowed: true,
      kind: 'lan',
      matched: matched.cidr,
      interfaceName: matched.interfaceName || '設定で追加',
    };
  }
  return { allowed: false, kind: 'remote', matched: null };
}

function clientKind(req) {
  const address = req?.socket?.remoteAddress;
  if (isLoopbackAddress(address)) return 'local';
  return 'unknown';
}

function requestHostname(req) {
  const rawHost = String(req?.headers?.host || '').trim();
  if (!rawHost) return '127.0.0.1';
  try {
    const parsed = new URL(`http://${rawHost}`);
    if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::') return '127.0.0.1';
    return parsed.hostname;
  } catch (_) {
    return '127.0.0.1';
  }
}

function sameOriginRequest(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return true;
  try {
    const expected = new URL(`http://${req.headers.host}`);
    const actual = new URL(origin);
    return actual.protocol === 'http:' && actual.host === expected.host;
  } catch (_) {
    return false;
  }
}

module.exports = {
  VIRTUAL_INTERFACE_PATTERN,
  clientKind,
  collectLocalNetworks,
  evaluateAccess,
  ipv4InNetwork,
  ipv4Network,
  ipv6InNetwork,
  ipv6Network,
  isLoopbackAddress,
  matchNetworks,
  normalizeAddress,
  normalizeNetworkList,
  parseNetwork,
  requestHostname,
  sameOriginRequest,
};
