// SSRF 防护回归测试：web_fetch 的目标 URL 来自模型输出（可被用户 prompt 间接操控），
// isBlockedFetchHost 是唯一的出站闸门 —— 这里把每一类绕过手法都钉成断言。
//
// 覆盖顺序与 src/net/ssrf.js 的判定层次一致：
//   1) 危险主机名（localhost / 各家云元数据服务）
//   2) IPv4 字面量私网与保留段（含 1~4 段简写、十进制单值）
//   3) WHATWG URL 归一化（十进制 / 十六进制 / 八进制写法）
//   4) FQDN 尾点
//   5) IPv6（压缩组展开、IPv4 映射、NAT64、链路本地、唯一本地、组播）
//   6) 公网地址必须放行（否则工具形同废掉）

import test from 'node:test';
import assert from 'node:assert/strict';

import { isBlockedFetchHost, expandIPv6Groups } from '../src/net/ssrf.js';

// 用真实用法取 hostname：web_fetch 里也是先 new URL() 再取 hostname，
// 归一化（0x7f → 127、2130706433 → 127.0.0.1）发生在这一步。
function hostOf(url) {
  return new URL(url).hostname;
}

test('空 hostname 按危险处理', () => {
  assert.equal(isBlockedFetchHost(''), true);
  assert.equal(isBlockedFetchHost(null), true);
  assert.equal(isBlockedFetchHost(undefined), true);
  assert.equal(isBlockedFetchHost('...'), true);
});

test('危险主机名：localhost 及其子域', () => {
  assert.equal(isBlockedFetchHost('localhost'), true);
  assert.equal(isBlockedFetchHost('LOCALHOST'), true);
  assert.equal(isBlockedFetchHost('sub.localhost'), true);
  assert.equal(isBlockedFetchHost('localhost.'), true);
  assert.equal(isBlockedFetchHost('sub.localhost.'), true);
  // 形似但不同的域名必须放行
  assert.equal(isBlockedFetchHost('notlocalhost.com'), false);
  assert.equal(isBlockedFetchHost('localhost.example.com'), false);
});

test('危险主机名：各家云元数据服务', () => {
  for (const h of [
    'metadata.google.internal',
    'x.metadata.google.internal',
    'instance-data',
    'instance-data.compute.internal',
    'metadata.azure.internal',
    'metadata',
    'metadata.tencentyun.com',
    'metadata.alibaba.internal',
  ]) {
    assert.equal(isBlockedFetchHost(h), true, h + ' 应被拦截');
  }
  assert.equal(isBlockedFetchHost('metadata.example.com'), false);
});

test('危险主机名：把内网 IP 写进域名的 nip.io 变体', () => {
  assert.equal(isBlockedFetchHost('169.254.169.254.nip.io'), true);
  assert.equal(isBlockedFetchHost('a.169.254.169.254.nip.io'), true);
  assert.equal(isBlockedFetchHost('1.2.3.4.nip.io'), false);
});

test('IPv4 私网与回环段', () => {
  for (const h of [
    '10.0.0.1', '10.255.255.255',
    '127.0.0.1', '127.255.255.254',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255',
    '0.0.0.0',
  ]) {
    assert.equal(isBlockedFetchHost(h), true, h + ' 应被拦截');
  }
  // 相邻但不属于私网段的必须放行（172.15 / 172.32 是常见误伤点）
  assert.equal(isBlockedFetchHost('172.15.0.1'), false);
  assert.equal(isBlockedFetchHost('172.32.0.1'), false);
});

test('IPv4 保留段：云元数据、CGNAT、TEST-NET、组播与广播', () => {
  for (const h of [
    '169.254.169.254',   // AWS/GCP/Azure 元数据
    '169.254.0.1',
    '100.64.0.1',        // CGNAT / 阿里云元数据段
    '100.127.255.255',
    '192.0.0.1',         // IETF 协议保留
    '192.0.2.1',         // TEST-NET-1
    '198.18.0.1',        // 基准测试 / 代理保留
    '198.19.255.255',
    '198.51.100.7',      // TEST-NET-2
    '203.0.113.5',       // TEST-NET-3
    '224.0.0.1',         // 组播
    '239.255.255.255',
    '240.0.0.1',         // 保留
    '255.255.255.255',   // 广播
  ]) {
    assert.equal(isBlockedFetchHost(h), true, h + ' 应被拦截');
  }
  // 保留段边界外必须放行
  assert.equal(isBlockedFetchHost('100.63.0.1'), false);
  assert.equal(isBlockedFetchHost('100.128.0.1'), false);
  assert.equal(isBlockedFetchHost('198.20.0.1'), false);
  assert.equal(isBlockedFetchHost('223.255.255.255'), false);
});

test('IPv4 简写与单值写法（127.1 / 2130706433）', () => {
  assert.equal(isBlockedFetchHost('127.1'), true);
  assert.equal(isBlockedFetchHost('127.0.1'), true);
  assert.equal(isBlockedFetchHost('2130706433'), true);
  assert.equal(isBlockedFetchHost('10.1'), true);
  // 末段越界（3232235521 = 192.168.0.1 的十进制）按危险处理
  assert.equal(isBlockedFetchHost('3232235521'), true);
  // 越界段宁可拦截
  assert.equal(isBlockedFetchHost('300.1.1.1'), true);
});

test('WHATWG URL 归一化后仍能拦截（十进制 / 十六进制 / 八进制）', () => {
  assert.equal(hostOf('http://2130706433/'), '127.0.0.1');
  assert.equal(isBlockedFetchHost(hostOf('http://2130706433/')), true);

  assert.equal(hostOf('http://0x7f.0.0.1/'), '127.0.0.1');
  assert.equal(isBlockedFetchHost(hostOf('http://0x7f.0.0.1/')), true);

  assert.equal(hostOf('http://0177.0.0.1/'), '127.0.0.1');
  assert.equal(isBlockedFetchHost(hostOf('http://0177.0.0.1/')), true);

  // 十进制写法的云元数据地址
  assert.equal(isBlockedFetchHost(hostOf('http://2852039166/')), true);
});

test('FQDN 尾点不能绕过黑名单', () => {
  assert.equal(isBlockedFetchHost('127.0.0.1.'), true);
  assert.equal(isBlockedFetchHost('10.0.0.1.'), true);
  assert.equal(isBlockedFetchHost('169.254.169.254.'), true);
  assert.equal(isBlockedFetchHost('127.0.0.1....'), true);
});

test('IPv6：回环、未指定、链路本地、唯一本地、组播、文档与丢弃前缀', () => {
  for (const h of [
    '[::]', '[::1]',
    '[fe80::1]', '[febf::1]',
    '[fc00::1]', '[fd12:3456::1]',
    '[ff02::1]',
    '[100::1]',
    '[2001:db8::1]',
  ]) {
    assert.equal(isBlockedFetchHost(h), true, h + ' 应被拦截');
  }
  // 不带方括号的写法同样要拦
  assert.equal(isBlockedFetchHost('::1'), true);
  assert.equal(isBlockedFetchHost('fe80::1'), true);
});

test('IPv6：IPv4 映射与 NAT64 不能成为绕过通道', () => {
  for (const h of [
    '[::ffff:127.0.0.1]',   // 点分十进制嵌入
    '[::ffff:7f00:1]',      // 十六进制压缩
    '[::ffff:169.254.169.254]',
    '[64:ff9b::127.0.0.1]', // NAT64
    '[64:ff9b::a9fe:a9fe]',
  ]) {
    assert.equal(isBlockedFetchHost(h), true, h + ' 应被拦截');
  }
  // 映射到公网地址的应当放行
  assert.equal(isBlockedFetchHost('[::ffff:8.8.8.8]'), false);
});

test('IPv6：解析失败的地址按危险处理', () => {
  assert.equal(isBlockedFetchHost(':::'), true);
  assert.equal(isBlockedFetchHost('1:2:3'), true);
  assert.equal(isBlockedFetchHost('1:2:3:4:5:6:7:8:9'), true);
  assert.equal(isBlockedFetchHost('zzzz::1'), true);
});

test('公网地址必须放行', () => {
  for (const h of [
    'example.com',
    'api.github.com',
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '11.0.0.1',
    '[2606:4700:4700::1111]',
  ]) {
    assert.equal(isBlockedFetchHost(h), false, h + ' 应放行');
  }
});

test('expandIPv6Groups 按规范补零展开', () => {
  assert.deepEqual(expandIPv6Groups('::'), ['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0000']);
  assert.deepEqual(expandIPv6Groups('::1'), ['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0001']);
  assert.deepEqual(expandIPv6Groups('2001:db8::1'),
    ['2001', '0db8', '0000', '0000', '0000', '0000', '0000', '0001']);
  assert.deepEqual(expandIPv6Groups('1:2:3:4:5:6:7:8'),
    ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']);
  assert.deepEqual(expandIPv6Groups('ABCD::EF01'),
    ['abcd', '0000', '0000', '0000', '0000', '0000', '0000', 'ef01']);
});

test('expandIPv6Groups 对非法输入返回 null', () => {
  assert.equal(expandIPv6Groups(''), null);
  assert.equal(expandIPv6Groups('::1::2'), null);   // 多于一个 ::
  assert.equal(expandIPv6Groups('1:2:3'), null);    // 无 :: 却不足 8 组
  assert.equal(expandIPv6Groups('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(expandIPv6Groups('12345::1'), null); // 单组超过 4 位
  assert.equal(expandIPv6Groups('gggg::1'), null);
  assert.equal(expandIPv6Groups('2001:db8::1/64'), null); // 带前缀长度
});
