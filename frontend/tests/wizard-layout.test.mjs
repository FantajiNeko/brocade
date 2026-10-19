import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const start = styles.indexOf('/* ═══ 建链向导 ═══');
const end = styles.indexOf('/* ═══ 标记删除 ═══', start);
assert.ok(start >= 0, '建链向导样式标记存在');
assert.ok(end > start, '标记删除样式位于建链向导之后');
const wizard = styles.slice(start, end);

test('纳管与建链只保留机器详情式内层纸、不可点击的进度与底部操作条', () => {
  const paper = readFileSync(new URL('../src/ui/wizard-paper.tsx', import.meta.url), 'utf8');
  for (const file of ['nodes', 'chain-wizard']) {
    const source = readFileSync(new URL(`../src/panes/${file}.tsx`, import.meta.url), 'utf8');
    assert.match(source, /<WizardPaper/);
    assert.match(source, /<WizardPaperHeader/);
    assert.match(source, /<WizardFooter/);
    assert.doesNotMatch(source, /<WizardSummary/);
  }
  assert.match(paper, /nd-sheet nd-page pv-page/);
  assert.match(paper, /className="fg-sheet nd-paper"/);
  const nodes = readFileSync(new URL('../src/panes/nodes.tsx', import.meta.url), 'utf8');
  const panes = readFileSync(new URL('../src/panes/index.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(nodes, /bare \? <div className="fg-sheet">\{body\}<\/div>/);
  assert.doesNotMatch(panes, /variant: 'form', wrapInSheet:/);
  assert.match(paper, /panel config-panel/);
  assert.match(paper, /aria-current=.*current/);
  assert.match(styles, /\.pv-foot\s*\{[\s\S]*?position:\s*sticky;/);
  assert.match(styles, /\.pv-cmd pre\.code\s*\{[^}]*word-break:\s*normal;[^}]*overflow-wrap:\s*normal;/);
  assert.match(styles, /\.pv-cmd-word,\s*\.pv-flag\s*\{\s*white-space:\s*nowrap;/);
  const begin = styles.indexOf('/* ═══ 纳管 / 建链');
  assert.ok(begin >= 0 && begin < start, '共享向导样式位于建链向导之前');
  const shared = styles.slice(begin, start);
  assert.doesNotMatch(shared, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(shared, /background:\s*var\(--sheet\)/);
  assert.match(shared, /@container \(max-width:\s*700px\)/);
  assert.match(shared, /\.pv-page\.nd-sheet\s*\{[\s\S]*?width:\s*auto;[\s\S]*?max-width:\s*none;/);
  assert.doesNotMatch(shared, /\.pv-page\.nd-sheet\s*\{[^}]*margin-inline:\s*0;/);
});

const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} 规则存在`);
  return match[1];
};

test('新建链接入协议保持逐行选择，中等宽度的端口与参数仍在同行', () => {
  const source = readFileSync(new URL('../src/panes/chain-wizard.tsx', import.meta.url), 'utf8');
  assert.match(source, /className=\{`protocol-choice wzp-card/);
  assert.match(source, /className="note bad wzp-issue" role="alert"/);
  assert.match(styles, /\.pv-chain-fields \.wzp\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(rule('.pv-chain-fields .wzp-card'), /grid-template-columns:\s*16px minmax\(0, 1fr\) auto auto;/);
  assert.match(rule('.pv-chain-fields .wzp-port'), /--ctl-h:\s*26px;[\s\S]*grid-column:\s*3;\s*grid-row:\s*1;/);
  assert.match(rule('.pv-chain-fields .wzp-more'), /grid-column:\s*4;\s*grid-row:\s*1;/);
  assert.match(
    styles,
    /@container \(max-width:\s*520px\)\s*\{\s*\.pv-chain-fields \.wzp-card\s*\{\s*grid-template-columns:\s*16px minmax\(0, 1fr\) auto;/,
  );
  // 问题行和参数区都按文档顺序自动排位：写死行号会让问题行落到展开的参数下面。
  assert.match(rule('.pv-chain-fields .wzp-card > .wzp-issue'), /grid-column:\s*2 \/ -1;/);
  assert.doesNotMatch(rule('.pv-chain-fields .wzp-body'), /grid-row/);
});

test('建链沿用公共纸面、面板、规则树与授权卡，不用页面级样式改写公共骨架', () => {
  const source = readFileSync(new URL('../src/panes/chain-wizard.tsx', import.meta.url), 'utf8');
  const paper = readFileSync(new URL('../src/ui/wizard-paper.tsx', import.meta.url), 'utf8');
  assert.equal(existsSync(new URL('../src/panes/chain-wizard.css', import.meta.url)), false);
  assert.doesNotMatch(source, /\.css'|chain-create|cc-(?:text-btn|draft-mark|field|protocol|certificate|port)/);
  assert.doesNotMatch(paper, /className=\{`(?:nd-sheet|pv-foot)/);
  assert.match(source, /aside=\{<span className="st st-gold">写入草稿<\/span>\}/);
  assert.match(source, /<WizardCard title="授权用户" icon="users"/);
  assert.match(source, /className="user-list-search"/);
  assert.match(source, /className="user-new-row"/);
  assert.match(source, /className="grant-card cc-user"/);
  assert.match(source, /<GeneratedUserAvatar id=\{user\.id\} variant="cell" \/>/);
  assert.match(source, /className="chain-path cc-route"/);
  assert.match(source, /className="cp-wire"/);
  assert.doesNotMatch(source, /出口地区标识|wzg-|wzi(?:-col)?|wz-app|wz-auto-region|wz-inline-alert/);
  assert.doesNotMatch(styles, /\.wzg-[\w-]+|\.wzi(?:-col)?\b|\.wz-app\b|\.wz-auto-region[\w-]*|\.wz-inline-alert/);

  // 授权格只改排列，选中、悬停与禁用都来自 .grant-card。
  assert.match(rule('.grant-card[aria-pressed=\'true\']'), /background:\s*var\(--action-wash\);/);
  const pick = rule('.pv-chain-fields .cc-user.grant-card');
  assert.match(pick, /flex-direction:\s*row;/);
  assert.doesNotMatch(pick, /border|background|color|font|radius/);

  const clean = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  const wizardRules = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) =>
    /\.(?:pv-chain-fields|cc-[\w-]+)\b/.test(selectors),
  );
  assert.ok(wizardRules.length > 20, '建链样式扫描异常');
  for (const [, selectors, declarations] of wizardRules) {
    // 可以给公共骨架挂容器查询，但不改它的材质、字号与尺寸。
    if (
      /\.(?:pv-head|pv-plate|pv-steps|pv-foot|pv-state|panel-title|config-panel|user-avatar|user-list-search|user-new-[\w-]+)\b/.test(
        selectors,
      )
    )
      assert.doesNotMatch(
        declarations,
        /(?:^|;)\s*(?:background|border[\w-]*|box-shadow|color|font[\w-]*|padding[\w-]*|(?:min-)?height|width)\s*:/,
        `${selectors.trim()}: 建链不得改写公共骨架`,
      );
    assert.doesNotMatch(declarations, /#[0-9a-f]{3,8}\b|rgba?\(|!important/i, `${selectors.trim()}: 只用语义令牌`);
  }
});

test('窄屏地址说明不继承桌面横向占位为卡片高度', () => {
  assert.match(wizard, /@media \(max-width:\s*820px\)[\s\S]*?\.wz-hop \.wz-field-note\s*\{\s*flex:\s*0 0 auto;/);
});
