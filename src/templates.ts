import { ActionType, TemplateContext } from './types';

type TemplateFn = (ctx: TemplateContext) => string;

interface TemplateEntry {
  type: 'humor' | 'tease' | 'encourage' | 'brutal' | 'philosophy' | 'calm';
  text: TemplateFn;
}

const map: Record<ActionType, TemplateEntry[]> = {
  // ===== 删函数 =====
  'delete-function': [
    { type: 'tease', text: (ctx) => `删了 ${ctx.fnName || '一个函数'}？写的时候可是信誓旦旦的` },
    { type: 'humor', text: (ctx) => `${ctx.fnName || '无名函数'}，卒，享年 ${ctx.lifetime || '未知'} 分钟` },
    { type: 'encourage', text: () => `舍得删函数的人，才是真正的强者` },
    { type: 'humor', text: (ctx) => `又一位烈士倒在了重构的路上——${ctx.fnName || '无名英雄'}` },
    { type: 'philosophy', text: (ctx) => `删掉 ${ctx.fnName || '这个函数'} 的那一刻，你在想什么？` },
    { type: 'humor', text: () => `删代码的速度比写代码快两倍，专业` },
    { type: 'brutal', text: (ctx) => `删前：完美方案。删后：什么垃圾 —— ${ctx.fnName || ''}` },
    { type: 'calm', text: (ctx) => `${ctx.fnName || '这个函数'} 存在了 ${ctx.lifetime || '一阵子'}，最终还是没被需要` },
    { type: 'calm', text: (ctx) => `已移除函数 ${ctx.fnName || ''}` },
    { type: 'tease', text: (ctx) => `${ctx.fnName || '这个函数'} 被删的时候，连个报错都没留下，体面` },
  ],

  // ===== 删大量代码 =====
  'delete-bulk': [
    { type: 'humor', text: (ctx) => `删了 ${ctx.lines} 行！你比刚才轻了 ${(ctx.lines * 0.05).toFixed(1)}g` },
    { type: 'brutal', text: (ctx) => `一口气删了 ${ctx.lines} 行，这是出了什么问题？` },
    { type: 'encourage', text: (ctx) => `删 ${ctx.lines} 行而不崩，这是高手的从容` },
    { type: 'humor', text: () => `删了就跑，真刺激` },
    { type: 'calm', text: (ctx) => `大扫除完毕，代码整洁度 +${Math.max(1, Math.ceil(ctx.lines / 8))}` },
    { type: 'brutal', text: (ctx) => `删了 ${ctx.lines} 行……但愿还能跑` },
    { type: 'philosophy', text: () => `删前深呼吸，删后不求人` },
    { type: 'philosophy', text: (ctx) => `致敬这 ${ctx.lines} 行代码，它们曾经努力过` },
    { type: 'encourage', text: (ctx) => `删 ${ctx.lines} 行是为了写更好的 ${Math.ceil(ctx.lines / 3)} 行，加油` },
  ],

  // ===== 换方案 =====
  'replace-solution': [
    { type: 'tease', text: (ctx) => `从方案 A 换到了方案 B，希望这次是对的` },
    { type: 'humor', text: (ctx) => `换成新方案了？你一周后会想换回来的` },
    { type: 'brutal', text: (ctx) => `又换方案了。这是今天的第 ${ctx.count} 次了` },
    { type: 'encourage', text: () => `你终于想通了，新方案确实比旧的好` },
    { type: 'humor', text: () => `换来换去，我记录得都累了` },
    { type: 'tease', text: () => `上周你刚说之前的方案是最好的选择` },
    { type: 'encourage', text: () => `这次换方案感觉不一样，好像真的对了` },
    { type: 'philosophy', text: () => `把方案 A 换成方案 B，这是有品位的选择` },
  ],

  // ===== 绕回原点 =====
  'back-to-origin': [
    { type: 'humor', text: (ctx) => `折腾了 ${ctx.lifetime || '半天'}，回到了最初的起点，记忆中你青涩的脸` },
    { type: 'brutal', text: (ctx) => `所以你刚才那 ${ctx.lifetime || '一会儿'} 到底在干嘛` },
    { type: 'philosophy', text: () => `人生就是一场循环，代码也是` },
    { type: 'brutal', text: (ctx) => `早用这个方案不就好了，浪费了 ${ctx.lines} 行代码` },
    { type: 'encourage', text: () => `至少你排除了一个错误答案` },
    { type: 'humor', text: () => `绕了一圈回到原点还能面不改色，专业` },
    { type: 'philosophy', text: () => `看山是山，看山不是山，看山还是山` },
    { type: 'tease', text: () => `我记下来了，我要在你年终总结里写这一笔` },
  ],

  // ===== 破纪录 =====
  'record-break': [
    { type: 'encourage', text: (ctx) => `新纪录！单次删除 ${ctx.lines} 行，超越了你自己` },
    { type: 'humor', text: (ctx) => `纪录刷新：这次一口气删了 ${ctx.lines} 行，手起刀落` },
    { type: 'brutal', text: (ctx) => `单次删除 ${ctx.lines} 行，上一任纪录 ${ctx.previousMax || 0} 行已经守不住了` },
    { type: 'philosophy', text: (ctx) => `删到 ${ctx.lines} 行这一刻，你已经不是刚才的你了` },
  ],

  // ===== 循环提醒 =====
  'loop-reminder': [
    { type: 'tease', text: (ctx) => `这段代码改第 ${ctx.count} 次了，你要不要跟它谈谈` },
    { type: 'humor', text: (ctx) => `已经改了 ${ctx.count} 轮了，要不要先喝杯水` },
    { type: 'brutal', text: (ctx) => `同一个位置改了 ${ctx.count} 次，这已经不是编程是行为艺术了` },
    { type: 'encourage', text: () => `精雕细琢，大师风范` },
  ],

  // ===== 放弃成本 =====
  'abandonment-cost': [
    { type: 'philosophy', text: (ctx) => `这段代码活了 ${ctx.lifetime || '很久'}，最终还是没挺过来` },
    { type: 'calm', text: (ctx) => `放弃成本已记录：这段实现存在了 ${ctx.lifetime || '一段时间'}` },
    { type: 'humor', text: (ctx) => `陪你走了 ${ctx.lifetime || '一阵子'} 的代码，今天正式退场` },
    { type: 'tease', text: (ctx) => `这段代码活了 ${ctx.lifetime || '这么久'}，最后还是没能转正` },
  ],

  // ===== 删调试代码 =====
  'debug-cleanup': [
    { type: 'encourage', text: (ctx) => `抓到了 ${ctx.lines} 个流浪的 console.log，干净了` },
    { type: 'humor', text: (ctx) => `清理了 ${ctx.lines} 条调试线索，案子结了` },
    { type: 'tease', text: (ctx) => `删了 ${ctx.lines} 条 console.log，用户终于不用看到你的 debug 史了` },
    { type: 'encourage', text: () => `发布前删 log，成熟的表现` },
    { type: 'calm', text: (ctx) => `代码保洁完成，清理垃圾 ${(ctx.lines * 0.05).toFixed(1)}KB` },
    { type: 'calm', text: () => `这些 log 还是不让用户看到比较好` },
    { type: 'humor', text: () => `痕迹清理完毕，假装从未 debug 过` },
    { type: 'brutal', text: () => `"这里没出错啊" —— console.log("到这里了1到100")` },
    { type: 'tease', text: () => `删了多少 debug 代码，就代表你迷茫了多久` },
  ],

  // ===== 早上开工 =====
  'early-morning': [
    { type: 'humor', text: (ctx) => `早！你首先打开了 ${ctx.fileName}，看来昨晚梦到它了` },
    { type: 'tease', text: () => `一大早就改代码，你确定你醒了吗` },
    { type: 'tease', text: (ctx) => `打开 ${ctx.fileName}，看来昨天没做完的噩梦还在` },
    { type: 'encourage', text: (ctx) => `早上第一件事就是改 ${ctx.fileName}，是个狠人` },
    { type: 'humor', text: (ctx) => `你盯着 ${ctx.fileName} 看了 3 分钟才动手，在想什么` },
    { type: 'encourage', text: (ctx) => `新的一天！从征服 ${ctx.fileName} 开始！` },
    { type: 'calm', text: (ctx) => `开始工作：${ctx.fileName}` },
    { type: 'philosophy', text: () => `清晨的代码最诚实，昨晚偷的懒都在这里` },
  ],

  // ===== 深夜写码 =====
  'late-night': [
    { type: 'tease', text: (ctx) => `凌晨 ${ctx.hour} 点还在删代码，建议先睡一觉明天看看会不会后悔` },
    { type: 'brutal', text: (ctx) => `凌晨 ${ctx.hour} 点删东西？你现在做的决定明天可能要还` },
    { type: 'philosophy', text: () => `深夜改代码的人，心里都有一段故事` },
    { type: 'brutal', text: () => `这个点删的代码，明天大概率会有人想恢复` },
    { type: 'humor', text: (ctx) => `凌晨 ${ctx.hour} 点还在写代码，你是码农还是吸血鬼` },
    { type: 'encourage', text: (ctx) => `凌晨 ${ctx.hour} 点还在加班，代码不说谎` },
    { type: 'encourage', text: () => `熬夜写代码的样子很狼狈，但提交代码的样子很帅` },
    { type: 'calm', text: (ctx) => `凌晨 ${ctx.hour} 点：还在编码` },
    { type: 'tease', text: () => `你在这个点写的代码，明天早上有 80% 概率会被删掉` },
    { type: 'philosophy', text: () => `深夜的代码没有 bug，只有夜盲` },
  ],

  // ===== 开始工作 =====
  'start-working': [
    { type: 'encourage', text: (ctx) => `开工！${ctx.fileName} 准备好了` },
    { type: 'humor', text: (ctx) => `打开 ${ctx.fileName}，开始今天的人机博弈` },
    { type: 'tease', text: () => `你终于开始写代码了，我还以为你要摸一天鱼` },
    { type: 'calm', text: (ctx) => `开始编辑：${ctx.fileName}` },
    { type: 'encourage', text: () => `每一次打开编辑器，都是一次新的冒险` },
  ],

  // ===== 删测试 =====
  'delete-test': [
    { type: 'brutal', text: () => `删测试？？你确定？？？` },
    { type: 'brutal', text: () => `删测试一时爽，上线火葬场` },
    { type: 'tease', text: (ctx) => `删了 ${ctx.lines} 个测试，你很自信啊` },
    { type: 'humor', text: () => `我假装没看到你删了测试` },
    { type: 'tease', text: () => `已记录，出 bug 的时候我会提醒你的` },
    { type: 'humor', text: () => `删测试不是因为懒，是因为代码已经完美了，对吧` },
    { type: 'encourage', text: () => `删掉冗余的测试也是一种重构` },
    { type: 'brutal', text: () => `测试覆盖率 -${Math.floor(Math.random() * 10) + 1}%` },
  ],

  // ===== 加注释 =====
  'add-comment': [
    { type: 'humor', text: (ctx) => `你写了一段注释，看来你也怕未来"自己」看不懂` },
    { type: 'tease', text: (ctx) => `注释写了 ${ctx.lines} 行，比代码还长，你已经赢了` },
    { type: 'encourage', text: () => `写注释的人，上辈子都是天使` },
    { type: 'brutal', text: () => `"这段代码以后再优化" —— 它永远不会被优化了` },
    { type: 'philosophy', text: () => `留下注释，是对未来接手你代码的人的温柔` },
    { type: 'calm', text: () => `新增注释` },
    { type: 'humor', text: () => `写注释的那一刻，你终于想起了自己也是个人类` },
  ],

  // ===== 新增代码块 =====
  'add-code': [
    { type: 'encourage', text: (ctx) => `${ctx.fileName} 新增了 ${ctx.addedLines || ctx.lines} 行代码，用力输出中` },
    { type: 'humor', text: (ctx) => `一口气写了 ${ctx.addedLines || ctx.lines} 行，今天状态不错` },
    { type: 'calm', text: (ctx) => `新增 ${ctx.addedLines || ctx.lines} 行代码` },
    { type: 'tease', text: (ctx) => `写了 ${ctx.addedLines || ctx.lines} 行新代码，希望这次不用删` },
    { type: 'humor', text: () => `代码在生长，项目在膨胀` },
    { type: 'encourage', text: () => `写代码的手感来了，继续保持` },
  ],

  // ===== 沉没成本 =====
  'sunk-cost': [
    { type: 'philosophy', text: (ctx) => `删掉的代码里有 ${ctx.commentCount || 0} 条注释，它们也跟着走了` },
    { type: 'tease', text: (ctx) => `当初加的 ${ctx.commentCount || 0} 条注释，现在看来都是遗言` },
    { type: 'humor', text: (ctx) => `连注释都写了 ${ctx.commentCount || 0} 条，结果还是没救回来` },
    { type: 'calm', text: (ctx) => `已删除代码块，其中包含 ${ctx.commentCount || 0} 行注释` },
  ],

  // ===== 多文件改动 =====
  'multi-file': [
    { type: 'encourage', text: (ctx) => `一口气改动了 ${ctx.lines} 个文件，你今天状态不错` },
    { type: 'philosophy', text: (ctx) => `改了一个文件，牵动了 ${ctx.lines} 个文件，蝴蝶效应` },
    { type: 'tease', text: (ctx) => `${ctx.lines} 个文件同时被改，你控制得住吗` },
    { type: 'humor', text: (ctx) => `牵一发而动全身，改了 ${ctx.lines} 个文件` },
    { type: 'encourage', text: (ctx) => `${ctx.lines} 个文件改完还能跑，说明你心里有数` },
    { type: 'calm', text: (ctx) => `修改 ${ctx.lines} 个文件` },
    { type: 'brutal', text: (ctx) => `同时改 ${ctx.lines} 个文件 —— 重构是好事，一次性改太多就不一定了` },
  ],

  // ===== 秒写秒删 =====
  'quick-undo': [
    { type: 'humor', text: (ctx) => `写了 ${ctx.lines} 秒就删了，打字速度不错` },
    { type: 'tease', text: () => `这是一个"写出来就是为了删掉"的代码` },
    { type: 'humor', text: () => `这段代码还没看清世界就没了` },
    { type: 'brutal', text: () => `写-删速度：手速 200+，有效输出 0` },
    { type: 'tease', text: () => `你刚才的操作可以概括为："不，你不想"` },
    { type: 'philosophy', text: () => `有些代码，从诞生那一刻就注定了被删除的命运` },
    { type: 'encourage', text: () => `快速试错，快速放弃，敏捷开发精髓` },
    { type: 'humor', text: () => `这段代码的存在时间比你的注意力还短` },
  ],

  // ===== 重构 =====
  'refactor': [
    { type: 'tease', text: (ctx) => `重构 ${ctx.fileName}？太好了，又有活干了` },
    { type: 'encourage', text: () => `有勇气重构的才是真程序员` },
    { type: 'humor', text: () => `重构完了，感觉整个项目都干净了` },
    { type: 'brutal', text: (ctx) => `重构 ${ctx.fileName}……你确定不是重写？` },
    { type: 'encourage', text: () => `重构完成，代码像刚洗过澡一样清爽` },
    { type: 'tease', text: () => `重构有风险，动手需谨慎` },
    { type: 'philosophy', text: () => `每一次重构，都是在偿还技术债` },
    { type: 'humor', text: () => `重构完了没有出 bug，你运气不错` },
  ],

  // ===== 删旧代码 =====
  'delete-old-code': [
    { type: 'philosophy', text: (ctx) => `删掉 ${ctx.lifetime || ''} 天前写的代码，那时的你是怎么想的` },
    { type: 'encourage', text: () => `删掉过去的自己写的代码，是一种成长` },
    { type: 'humor', text: (ctx) => `看到 ${ctx.lifetime || ''} 天前的代码，终于忍不住删了` },
    { type: 'philosophy', text: () => `跟过去的自己说再见` },
    { type: 'encourage', text: () => `勇敢地删除旧代码，才有空间写新代码` },
    { type: 'tease', text: (ctx) => `${ctx.lifetime || ''} 天前的你：这代码无敌了。现在的你：这代码什么玩意` },
    { type: 'calm', text: () => `清理历史遗留代码` },
    { type: 'brutal', text: () => `连你自己都看不下去了，这代码确实该删` },
  ],

  // ===== 反复修改 =====
  'back-and-forth': [
    { type: 'tease', text: (ctx) => `同一个位置改了 ${ctx.count} 次了，你确定这次满意了吗` },
    { type: 'humor', text: (ctx) => `已经改了 ${ctx.count} 次了，要不要先喝杯水` },
    { type: 'brutal', text: (ctx) => `来回改同一个地方 ${ctx.count} 次，这就是编程的浪漫` },
    { type: 'encourage', text: () => `精雕细琢，大师风范` },
    { type: 'humor', text: (ctx) => `这段代码的修改次数（${ctx.count} 次）已经超过了你的微信步数` },
    { type: 'tease', text: () => `改吧改吧，反正最后还是要改回来` },
    { type: 'brutal', text: (ctx) => `同一个位置改了 ${ctx.count} 次，这已经不是编程是行为艺术了` },
    { type: 'humor', text: (ctx) => `你再改一次试试，我就……算了你肯定会再改的` },
  ],

  // ===== 通用 =====
  'general': [
    {
      type: 'calm',
      text: (ctx) => `编辑 ${ctx.fileName}，新增 ${ctx.addedLines || 0} 行，删除 ${ctx.deletedLines || 0} 行`,
    },
    {
      type: 'calm',
      text: (ctx) => `更新 ${ctx.fileName}，变更 ${Math.max(ctx.addedLines || 0, ctx.deletedLines || 0)} 行`,
    },
    {
      type: 'calm',
      text: (ctx) => `已记录 ${ctx.fileName} 的一次代码变更`,
    },
  ],
};

/** 获取某类型的所有模板 */
export function getTemplates(type: ActionType): TemplateEntry[] {
  return map[type] || map['general'];
}

/** 根据风格过滤模板 */
function filterByStyle(
  entries: TemplateEntry[],
  style: string
): TemplateEntry[] {
  if (style === 'gentle') {
    return entries.filter(e => e.type === 'encourage' || e.type === 'calm' || e.type === 'philosophy');
  }
  if (style === 'brutal') {
    return entries.filter(e => e.type === 'brutal' || e.type === 'tease' || e.type === 'humor');
  }
  if (style === 'poetic') {
    return entries.filter(e => e.type === 'philosophy' || e.type === 'calm');
  }
  if (style === 'silent') {
    return []; // 无评语
  }
  return entries; // balanced: 全部
}

/** 生成一条评语 */
export function generateMessage(
  actionType: ActionType,
  ctx: TemplateContext,
  style: string = 'balanced'
): string {
  if (style === 'silent') {
    // silent 模式下只返回事实描述
    const actionNames: Record<ActionType, string> = {
      'delete-function': '删除函数',
      'delete-bulk': '删除大量代码',
      'replace-solution': '替换方案',
      'back-to-origin': '回到原点',
      'record-break': '刷新纪录',
      'loop-reminder': '循环提醒',
      'abandonment-cost': '放弃成本',
      'debug-cleanup': '清理调试代码',
      'early-morning': '开始工作',
      'late-night': '深夜编码',
      'start-working': '开始编辑',
      'delete-test': '删除测试',
      'add-comment': '添加注释',
      'add-code': '新增代码',
      'sunk-cost': '沉没成本',
      'multi-file': '多文件改动',
      'quick-undo': '快速撤销',
      'refactor': '重构',
      'delete-old-code': '清理旧代码',
      'back-and-forth': '反复修改',
      'general': '编辑代码',
    };
    return `[${actionNames[actionType]}] ${ctx.fileName}`;
  }

  const templates = filterByStyle(map[actionType] || map['general'], style);
  if (templates.length === 0) {
    return `编辑了 ${ctx.fileName}`;
  }
  const template = templates[Math.floor(Math.random() * templates.length)];
  return template.text(ctx);
}
