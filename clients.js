/**
 * Who is calling: the main agent, another family bot (say a family member's work bot that forwards receipts), or the dashboard.
 * Each remote MCP client has its own token, a name that is stamped on what it changes in the shared fridge and
 * kitchen, and a scope:
 *   full    — everything the everyday surface offers (the main agent).
 *   kitchen — the household's shared kitchen only: fridge, menus, the cookbook, kitchen preferences, and
 *             package labels into the shared food library. No member's meals, health, plans or medicine.
 * A name is not a member: it says which client wrote, not whose body or ledger it is.
 */
import { timingSafeEqual } from 'node:crypto';

export const SCOPES = Object.freeze({
  full: null,
  kitchen: Object.freeze({
    reads: ['pantry', 'kitchen', 'menu', 'cookbook', 'foods'],
    writes: ['pantry', 'menu', 'kitchen_pref', 'kitchen_recipe', 'food_add'],
  }),
  // The dashboard: the kitchen, plus fixing a recorded dose by hand (wrong amount, never happened).
  page: Object.freeze({
    reads: ['pantry', 'kitchen', 'menu', 'cookbook', 'foods', 'timeline', 'meds'],
    writes: ['pantry', 'menu', 'kitchen_pref', 'kitchen_recipe', 'food_add', 'med'],
    med: ['fix', 'remove'],
  }),
});
const STAMPED = new Set(['pantry', 'menu', 'kitchen_pref', 'kitchen_recipe', 'med']);
const NAME = /^[\p{L}\p{N}_ .-]{1,40}$/u;

/** Clients from MCP_HTTP_TOKEN (the main agent) plus MCP_CLIENTS='[{"name","token","scope"}]'. */
export function loadClients(config) {
  const out = [];
  const add = ({ name, token, scope = 'kitchen' }, where) => {
    if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw Error(`${where}: token must be a secret of at least 32 bytes`);
    if (typeof name !== 'string' || !NAME.test(name)) throw Error(`${where}: name must be 1–40 letters, digits, space, _ . -`);
    if (!['full', 'kitchen'].includes(scope)) throw Error(`${where}: scope must be full or kitchen`); // 'page' is the dashboard's own
    if (out.some(c => c.name === name)) throw Error(`${where}: duplicate client name ${name}`);
    if (out.some(c => c.token === token)) throw Error(`${where}: two clients share a token`);
    out.push(Object.freeze({ name, token, scope }));
  };
  if (config.MCP_HTTP_TOKEN) add({ name: (config.MCP_HTTP_CLIENT_NAME || config.NUTRITION_AGENT_ACTOR || 'agent').trim(), token: config.MCP_HTTP_TOKEN, scope: 'full' }, 'MCP_HTTP_TOKEN');
  if (config.MCP_CLIENTS) {
    let list;
    try { list = JSON.parse(config.MCP_CLIENTS); } catch { throw Error('MCP_CLIENTS must be a JSON array'); }
    if (!Array.isArray(list)) throw Error('MCP_CLIENTS must be a JSON array');
    list.forEach((c, i) => add(c ?? {}, `MCP_CLIENTS[${i}]`));
  }
  return out;
}

export function findClient(clients, bearer) {
  if (typeof bearer !== 'string') return null;
  const b = Buffer.from(bearer);
  let hit = null;
  for (const c of clients) {
    const t = Buffer.from(c.token);
    if (t.length === b.length && timingSafeEqual(t, b)) hit = c; // no early exit: every token is compared
  }
  return hit;
}

/** The everyday surface as one client may use it; writes to the shared kitchen carry the client's name. */
export function scopedEveryday(everyday, client) {
  const scope = SCOPES[client.scope];
  return {
    async query(args = {}) {
      const view = args.view ?? 'summary';
      if (scope && !scope.reads.includes(view)) throw Error(`客户端「${client.name}」只能看：${scope.reads.join('、')}`);
      return everyday.query(args);
    },
    async execute({ operation, args = {}, ...rest } = {}) {
      if (scope) {
        if (!scope.writes.includes(operation)) throw Error(`客户端「${client.name}」只能写：${scope.writes.join('、')}`);
        if (operation === 'food_add' && !args.label) throw Error(`客户端「${client.name}」只能按包装标签加食品（food_add 带 label）`);
        if (operation === 'menu' && Array.isArray(args.plan) && args.plan.length) throw Error(`客户端「${client.name}」不能把菜排进个人计划`);
        if (operation === 'med' && scope.med && !scope.med.includes(args.action)) throw Error(`客户端「${client.name}」在药箱只能：${scope.med.join('、')}`);
      }
      const stamped = STAMPED.has(operation) ? { ...args, by: client.name } : args;
      return everyday.execute({ operation, args: stamped, ...rest });
    },
  };
}
