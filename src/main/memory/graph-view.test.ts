import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMemoryMode } from "./memory-mode";
import { loadMemoryGraph } from "./graph-view";

const f = vi.hoisted(()=>({vector:vi.fn(),wiki:vi.fn(),summary:vi.fn()}));
vi.mock("electron",()=>({app:{getPath:()=>"fixture"}}));
vi.mock("./entity-graph",()=>({entityGraph:{load:()=>({entities:[],relations:[]})}}));
vi.mock("./memory-store",()=>({memoryStore:{load:f.vector}}));
vi.mock("./wiki-memory-scheduler",()=>({getWikiMemoryStore:f.wiki}));
vi.mock("./summary-memory-context",()=>({loadSummaryMemoryContext:f.summary}));
vi.mock("../chats/active-conversation-registry",()=>({activeConversationRegistry:{getMostRecent:()=>({sessionId:"conversation"})}}));
vi.mock("../chats/chats-store",()=>({getSessionRecord:vi.fn()}));
vi.mock("../relationship/relationship-log",()=>({getRelationshipStore:()=>({privateExpressions:()=>[],expressionEvidence:()=>[]})}));
describe("evidence projected from the selected memory engine",()=>{
  beforeEach(()=>{vi.clearAllMocks();setMemoryMode("off");});
  it("opens an empty graph without touching disabled engines",async()=>{
    expect(await loadMemoryGraph()).toEqual({nodes:[],edges:[]});
    for(const fn of Object.values(f)) expect(fn).not.toHaveBeenCalled();
  });
  it("only links existing records and excludes deleted evidence text",async()=>{
    setMemoryMode("vector");
    f.vector.mockResolvedValue({l2:[{id:"first",content:"当前文字",status:"merged",mergedInto:"second",sourceQuote:"已删原话"},{id:"second",content:"更正后的记忆",status:"active",supersededBy:"missing"}],evidence:[{id:"gone",memoryId:"first",sourceStatus:"deleted",quoteSnippet:"已删原话"},{id:"real",memoryId:"second",sourceStatus:"active",quoteSnippet:"保留的证据",conversationId:"abc"}]});
    const graph=await loadMemoryGraph();
    expect(graph.edges).toContainEqual(expect.objectContaining({from:"memory:first",to:"memory:second",label:"已合并到"}));
    expect(JSON.stringify(graph)).toContain("保留的证据");
    expect(JSON.stringify(graph)).not.toMatch(/已删原话|missing/);
  });
  it("projects actual Wiki assertions, tags and references, excluding revocations",async()=>{
    setMemoryMode("wiki");
    f.wiki.mockReturnValue({countPages:()=>1,listPages:()=>[{id:"fish",summary:"档案"}],readPage:()=>({id:"fish",title:"昔涟",links:[],tags:["chat"],claims:[{id:"1",status:"current",value:"喜欢种花",sources:[{kind:"chat",conversationId:"abc",messageId:"m",revision:"v",evidenceQuote:"阳台种花"}]},{id:"2",status:"revoked",value:"撤回的说法",sources:[]}]})});
    const graph=await loadMemoryGraph();
    expect(JSON.stringify(graph)).toContain("阳台种花");
    expect(JSON.stringify(graph)).not.toContain("撤回的说法");
    expect(graph.edges.some(edge=>edge.weak&&edge.to==="tag:chat")).toBe(true);
  });
  it("attaches an available summary to its own conversation",async()=>{
    setMemoryMode("summary");
    f.summary.mockResolvedValue({sessionContent:"一起修花架",workspaceContent:""});
    const graph=await loadMemoryGraph();
    expect(graph.nodes.find(n=>n.kind==="记忆")?.detail).toBe("一起修花架");
    expect(graph.edges[0].to).toBe("chat:conversation");
  });
});
