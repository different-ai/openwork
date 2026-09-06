import { expect } from "vitest";
import type { SpecBodyContext } from "@openwork/testkit";
import type { Target } from "@openwork/cdp";
import type { onboardingDemo } from "../worlds/onboarding-demo.ts";

type Context = SpecBodyContext<Awaited<ReturnType<typeof onboardingDemo>>>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
export async function typeField(ctx: Context, target: Target, value: string) {
  await ctx.user.type(target, value, { intervalMs: 65 });
  await ctx.user.see(target, { value });
}
export async function organizations(ctx: Context) {
  const r = await ctx.probe.api(ctx.world.den.admin, "/v1/me/orgs");
  expect(r.response.ok).toBe(true);
  if (!isRecord(r.body) || !Array.isArray(r.body.orgs)) throw new Error("Expected organizations");
  return r.body.orgs.filter(isRecord);
}
export async function createAccount(ctx: Context) {
  const {user,world,step,evidence}=ctx;
  await user.see({text:"Good work starts here."},{timeoutMs:90_000});
  await step("Enter email",()=>typeField(ctx,{role:"textbox",label:"Email"},world.owner.email));
  await step("Continue to account details",()=>user.click({role:"button",label:"Next"}));
  await step("Enter name",()=>typeField(ctx,{role:"textbox",label:"Name"},world.owner.name));
  await step("Enter password",()=>typeField(ctx,{role:"textbox",label:"Password"},world.owner.password));
  await step("Create account",async()=>{
    await user.click({role:"button",label:"Sign up"});
    await user.see({text:"Make it yours."},{timeoutMs:90_000});
    await world.adoptSignedInOwner();
    expect(await organizations(ctx)).toEqual([]);
    evidence.recordAssertionEvidence("Account created through signup", "Signed in with no organization created prematurely",true);
  });
}
export async function createWorkspace(ctx: Context) {
  const {user,step,evidence}=ctx;
  await step("Choose personal workspace",()=>user.click({text:"On my own"}));
  await step("Name workspace",()=>typeField(ctx,{role:"textbox",label:"Organization name"},"Studio"));
  await step("Create workspace",async()=>{
    await user.click({role:"button",label:"Continue"});
    await user.see({text:"Bring your people."},{timeoutMs:90_000});
  });
  const orgs=await organizations(ctx);expect(orgs).toHaveLength(1);
  const org=orgs[0];expect(org.name).toBe("Studio");
  if(typeof org.id!=="string")throw new Error("Workspace has no id");
  evidence.recordAssertionEvidence("One Studio workspace created",JSON.stringify(orgs),true);
  return org.id;
}
export async function addPeople(ctx: Context, orgId:string) {
  const {user,world,step,probe,evidence}=ctx;
  for(const [i,email] of world.invitees.entries())
    await step(`Enter teammate ${i+1}`,()=>typeField(ctx,{role:"textbox",label:`Teammate email ${i+1}`},email));
  await step("Send invitations",async()=>{
    await user.click({role:"button",label:"Send invitations"});
    await user.see({text:"2 invitations sent."},{timeoutMs:90_000});
    const r=await probe.api(world.den.admin,"/v1/org",{headers:{"x-openwork-org-id":orgId}});
    expect(r.response.ok).toBe(true);
    if(!isRecord(r.body)||!Array.isArray(r.body.invitations))throw new Error("Expected invitations");
    const invitations=r.body.invitations.filter(isRecord);
    expect(invitations).toHaveLength(2);
    for(const email of world.invitees)expect(invitations).toContainEqual(expect.objectContaining({email,role:"member",status:"pending"}));
    const outbox=await probe.api(world.den.admin,"/v1/dev/emails?template=organizationInvite");
    if(!isRecord(outbox.body)||!Array.isArray(outbox.body.emails))throw new Error("Expected development outbox");
    const emails=outbox.body.emails.filter(isRecord);
    for(const email of world.invitees)expect(emails.filter(e=>e.to===email)).toHaveLength(1);
    evidence.recordAssertionEvidence("Two teammates invited once as members",JSON.stringify({invitations,delivery:"development outbox"}),true);
    await user.screenshot();
  });
  await step("Continue to tools",async()=>{
    await user.click({role:"button",label:"Continue"});
    await user.see({text:"Give your team a head start."},{timeoutMs:90_000});
  });
}
export async function selectTools(ctx:Context,orgId:string) {
  const {user,step,probe,world,evidence}=ctx;
  for(const name of ["Notion","Linear"])
    await step(`Select ${name}`,()=>user.click({role:"checkbox",label:`Add ${name}`}));
  await step("Add selected tools",async()=>{
    await user.click({role:"button",label:"Add to team"});
    await user.see({text:"Added to team"},{timeoutMs:90_000});
    const r=await probe.api(world.den.admin,"/v1/mcp-connections?scope=manageable",{headers:{"x-openwork-org-id":orgId}});
    expect(r.response.ok).toBe(true);
    if(!isRecord(r.body)||!Array.isArray(r.body.connections))throw new Error("Expected connections");
    const connections=r.body.connections.filter(isRecord);expect(connections).toHaveLength(2);
    for(const name of ["Notion","Linear"])expect(connections).toContainEqual(expect.objectContaining({name,connectedForMe:false,credentialMode:"per_member"}));
    evidence.recordAssertionEvidence("Notion and Linear added for the workspace", "Two configurations saved; neither member account is authorized",true);
    await user.screenshot();
  });
  await step("Continue to download",async()=>{
    await user.click({role:"button",label:"Continue"});
    await user.see({role:"link",text:"Download for Linux"},{timeoutMs:90_000});
  });
}
export async function downloadDesktop(ctx:Context) {
  const {user,world,probe,step,evidence}=ctx;
  if(!world.film)throw new Error("Set OPENWORK_EVAL_FILM_DIR for this recording journey");
  const film=world.film;
  await step("Download OpenWork",()=>user.click({role:"link",text:"Download for Linux"}));
  await step("Download completes",async()=>{
    const completed=await probe.eventually(()=>film.downloads.find(d=>d.state==="completed"),{within:180_000,label:"installer completed",until:Boolean});
    const begun=film.downloads.find(d=>d.event==="Browser.downloadWillBegin");
    expect(begun?.suggestedFilename).toMatch(/^openwork-linux-x86_64-.*\.AppImage$/);
    expect(completed?.guid).toBe(begun?.guid);
    expect(completed?.receivedBytes).toBeGreaterThan(1_000_000);
    expect(completed?.receivedBytes).toBe(completed?.totalBytes);
    expect(film.downloads.some(d=>d.state==="canceled")).toBe(false);
    evidence.recordAssertionEvidence("Desktop installer downloaded completely",JSON.stringify(completed),true);
    await user.screenshot();await film.stop();
  });
}
