'use strict';

/**
 * 彩色终端输出（手写 ANSI，不装第三方库；NO_COLOR 或非 TTY 时自动关闭）
 */

const enabled = !process.env.NO_COLOR && process.stdout.isTTY;

function c(code, s) {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s);
}
const bold = (s) => c('1', s);
const dim = (s) => c('90', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const magenta = (s) => c('35', s);
const cyan = (s) => c('36', s);

/** 分 → 元展示（只在展示层换算，内部运算全用分） */
function yuan(fen) {
  return `¥${(fen / 100).toFixed(2)}`;
}
function pct(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0.0%';
}

/** CJK 感知的字符串显示宽度（表格对齐用） */
function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1;
  }
  return w;
}
function pad(s, width) {
  const s2 = String(s);
  return s2 + ' '.repeat(Math.max(0, width - strWidth(s2)));
}
function padStart(s, width) {
  const s2 = String(s);
  return ' '.repeat(Math.max(0, width - strWidth(s2))) + s2;
}
/** 简单对齐表格：rows[0] 为表头 */
function table(rows) {
  if (!rows || rows.length === 0) return '';
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, strWidth(String(cell)));
    });
  }
  const line = (row) => row.map((cell, i) => pad(cell, widths[i])).join('  ');
  const out = [line(rows[0])];
  if (rows.length > 1) {
    out.push(widths.map((w) => '─'.repeat(w)).join('  '));
    for (let i = 1; i < rows.length; i++) out.push(line(rows[i]));
  }
  return out.join('\n');
}

function progress(msg) {
  process.stdout.write(`${dim(msg)}\n`);
}

function printHelp() {
  const lines = [
    `${bold('🍟 麦门拼单官 mcd-tuan-optimizer')} ${dim('v1.0.0')} — 基于麦当劳 MCP 的办公室拼单优化 CLI`,
    '',
    `${bold('用法:')}`,
    `  mctuan stores --city 北京 --keyword 王府井          ${dim('查找附近门店（到店自取）')}`,
    `  mctuan menu --store 1950526 [--category 小食]       ${dim('查看门店菜单（表格+价格）')}`,
    `  mctuan grab                                        ${dim('一键领取所有可领的券')}`,
    `  mctuan coupons --store 1950526                     ${dim('查看该门店可用券')}`,
    `  mctuan optimize --wishlist order.json [--auto-add] ${bold('拼单优化（主命令）')}`,
    `  mctuan optimize --demo [--auto-add]                ${dim('内置演示数据，无需 Token')}`,
    '',
    `${bold('环境变量:')}`,
    `  MCD_TOKEN   ${dim('麦当劳 MCP Token，到 open.mcd.cn/mcp 申请')}`,
    '',
    `${bold('说明:')}`,
    `  ${dim('全流程：找店 → 菜单 → 领券 → 组合优化 → 真实算价 → AA 分摊')}`,
    `  ${dim('本工具只做「算价参谋」，绝不真实下单。')}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function renderVersion() {
  process.stdout.write(`${bold('麦门拼单官')} mcd-tuan-optimizer v1.0.0\n`);
}

function renderError(e) {
  const msg = (e && e.message) || String(e);
  process.stderr.write(`${red('✖ 出错了：')}${msg}\n`);
  if (e && e.code === 'NO_TOKEN') {
    process.stderr.write(
      `  ${dim('请到 open.mcd.cn/mcp 申请 Token 并设置 MCD_TOKEN 环境变量')}\n`
    );
    process.stderr.write(`  ${dim('Linux/macOS:  export MCD_TOKEN=xxx')}\n`);
    process.stderr.write(`  ${dim('Windows:     $env:MCD_TOKEN="xxx"（PowerShell）')}\n`);
    process.stderr.write(`  ${dim('也可以先跑离线演示：node bin/mctuan.js optimize --demo')}\n`);
  }
}

function renderStores(stores, { city, keyword } = {}) {
  if (!stores || stores.length === 0) {
    process.stdout.write(`${yellow('未找到门店，换个关键词试试？')}\n`);
    return;
  }
  process.stdout.write(
    `${bold('🍟 附近门店')}${dim(`（${city || ''} · ${keyword || ''}）`)}\n\n`
  );
  stores.forEach((s, i) => {
    process.stdout.write(
      `  ${bold(`${i + 1}. ${s.storeName || s.storeNameCn || '门店'}`)} ${dim(`[${s.storeCode}]`)}\n`
    );
    if (s.address) process.stdout.write(`     ${dim(s.address)}\n`);
    if (s.distance) process.stdout.write(`     ${dim(`距离 ${s.distance}`)}\n`);
  });
  process.stdout.write(
    `\n${dim('下一步: mctuan menu --store ' + stores[0].storeCode + ' 查看菜单')}\n`
  );
}

function renderMenu(mealsList, categories, categoryFilter) {
  const rows = [[bold('分类'), bold('餐品'), bold('现价'), bold('原价')]];
  const catByName = new Map();
  (categories || []).forEach((cat) => {
    (cat.meals || []).forEach((m) => catByName.set(m.code, cat.name));
  });
  let list = mealsList;
  if (categoryFilter) {
    list = mealsList.filter(
      (m) => (catByName.get(m.code) || '').includes(categoryFilter)
    );
  }
  for (const m of list) {
    const cat = catByName.get(m.code) || '-';
    const price = `${yuan(m.currentPriceFen)}`;
    const orig = m.originalPriceFen > m.currentPriceFen
      ? dim(`${yuan(m.originalPriceFen)}`)
      : dim('-');
    rows.push([cat, m.name, price, orig]);
  }
  if (list.length === 0) {
    process.stdout.write(`${yellow('该分类下没有餐品，试试别的分类名（如：小食 / 饮品 / 人气热卖）')}\n`);
    return;
  }
  process.stdout.write(
    `${bold('📖 门店菜单')}${categoryFilter ? dim(` · 分类「${categoryFilter}」`) : ''} ${dim(`（共 ${list.length} 项）`)}\n\n`
  );
  process.stdout.write(table(rows) + '\n');
}

function renderCoupons(coupons, storeCode) {
  if (!coupons || coupons.length === 0) {
    process.stdout.write(`${yellow('这家店当前没有可用券，试试 mctuan grab 先领券')}\n`);
    return;
  }
  process.stdout.write(
    `${bold('🎫 门店可用券')}${dim(`（store ${storeCode} · ${coupons.length} 张）`)}\n\n`
  );
  coupons.forEach((c, i) => {
    const products = (c.products || []).map((p) => p.productName).join('、');
    process.stdout.write(`  ${bold(`${i + 1}. ${c.title}`)}\n`);
    if (products) process.stdout.write(`     ${dim(`适用: ${products}`)}\n`);
    process.stdout.write(
      `     ${dim(`couponId: ${c.couponId} · couponCode: ${c.couponCode}${c.tradeDateTime ? ' · ' + c.tradeDateTime : ''}`)}\n`
    );
  });
}

function renderGrabResult(coupons) {
  if (!coupons || coupons.length === 0) {
    process.stdout.write(`${yellow('当前没有可领的券（可能已全部领过）')}\n`);
    return;
  }
  process.stdout.write(`${bold(`🎉 一键领券成功，共领取 ${green(coupons.length)} 张：`)}\n\n`);
  coupons.forEach((c, i) => {
    process.stdout.write(`  ${i + 1}. ${bold(c.title || c.titleName || '优惠券')}\n`);
  });
  process.stdout.write(`\n${dim('可运行 mctuan coupons --store <storeCode> 查看门店可用券')}\n`);
}

/**
 * 渲染最优拼单方案（主输出）
 * data: { storeName, peopleCount, items, base, best:{assignment,result}, coupons,
 *         split:{shares,residualFen,initiator,balanced}, suggestion, calls, mode,
 *         autoAdded, budgetFen }
 */
function renderOptimize(data) {
  const { storeName, items, best, coupons, split, suggestion } = data;
  const result = best.result;
  const saved = result.originalPrice - result.price;
  const out = [];
  out.push('');
  out.push(
    `${bold('🍟 麦门拼单官 · 最优拼单方案')} ${dim(`（${storeName} · ${data.peopleCount} 人拼单）`)}`
  );
  out.push(dim('─'.repeat(46)));

  // 拼单篮
  out.push(`${bold('🛒 拼单篮:')}`);
  for (const it of items) {
    const persons = (it.persons || []).map((p) => p.name).join('、');
    out.push(
      `   ${pad(it.name, 18)}${dim('×' + it.quantity)}  ${pad(yuan(it.unitPriceFen * it.quantity), 9)}${dim('→ ' + persons)}`
    );
  }
  out.push('');

  // 实付对比
  out.push(
    `${bold('✅ 实付 ' + green(yuan(result.price)))}${dim(`（原价 ${yuan(result.originalPrice)}，共省 `)}${green(yuan(saved))}${dim(' · ' + pct(saved, result.originalPrice) + '）')}`
  );
  if (best.assignment.some((a) => a >= 0)) {
    out.push(`${bold('🎫 已用券:')}`);
    coupons.forEach((c, ci) => {
      const ii = best.assignment[ci];
      if (ii == null || ii < 0) return;
      const it = items[ii];
      const persons = (it.persons || []).map((p) => p.name).join('、');
      out.push(`   · ${bold(c.title)} ${dim('→')} 挂在 ${cyan(`[${it.name}]`)}${dim(`（${persons || '拼单篮'}）`)}`);
    });
  } else {
    out.push(`${yellow('🎫 当前没有可用上的券（这张券都不适用或都不划算）')}`);
  }

  // AA 分摊
  out.push(`${bold('💰 分摊:')} ${dim('（优惠按小计占比分配' + (split.residualFen ? '，尾差归发起人' : '') + '）')}`);
  for (const s of split.shares) {
    out.push(
      `   ${pad(s.name, 6)}${bold(yuan(s.payFen))}${dim(`（原 ${yuan(s.originalFen)}，省 ${yuan(s.discountFen)}）`)}`
    );
  }
  const sumPay = split.shares.reduce((a, s) => a + s.payFen, 0);
  const ok = sumPay === result.price;
  out.push(
    `   ${dim('─'.repeat(30))}\n   ${pad('合计', 6)}${bold(yuan(sumPay))} ${ok ? green('✓ 与实付对平') : red(`✗ 与实付 ${yuan(result.price)} 差 ${yuan(Math.abs(sumPay - result.price))}`)}`
  );

  // 凑单建议
  if (suggestion) {
    out.push('');
    out.push(
      `${bold('💡 凑单建议:')} +1 份${bold(suggestion.addon.name)}${dim(`(${yuan(suggestion.addon.unitPriceFen)})`)}`
    );
    out.push(
      `   ${dim(`实付 ${yuan(data.currentPriceFen)} → ${yuan(suggestion.newPriceFen)}，净省 `)}${green(yuan(suggestion.savingFen))}`
    );
    if (!data.autoAdded) {
      out.push(dim('   加 --auto-add 可自动加入凑单品'));
    }
  }

  // 统计与预算
  out.push('');
  out.push(
    dim(`📊 真实算价调用 calculate-price 共 ${data.calls} 次 · ${data.mode === 'exhaustive' ? '穷举模式' : '贪心+局部验证模式'}${data.autoAdded ? ' · 已自动加入凑单品' : ''}`)
  );
  if (data.budgetFen && result.price > data.budgetFen) {
    out.push(yellow(`⚠️ 实付超出预算 ${yuan(data.budgetFen)}，超支 ${yuan(result.price - data.budgetFen)}`));
  }
  out.push(dim('⚠️ 本工具只算价，不下单；价格以麦当劳官方渠道实时结果为准。'));
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

module.exports = {
  printHelp,
  renderVersion,
  renderError,
  renderStores,
  renderMenu,
  renderCoupons,
  renderGrabResult,
  renderOptimize,
  progress,
  table,
  yuan,
  pct,
};
