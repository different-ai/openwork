import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { pr5047ElectronProof } from "../worlds/pr5047-electron-proof";

const baselineOnly=process.env.PR5047_BASELINE_ONLY === "1";
const test=spec.world(pr5047ElectronProof,{timeout:480_000});
test(baselineOnly?"baseline dev Electron dashboard CSS timeout screenshot":"isolated Electron dashboard sandbox bootstrap and Retry screenshots",async({world,user,probe,evidence})=>{
  for(const mode of baselineOnly ? ["baseline"] : ["baseline","fixed","failure"]){
    await world.open(mode);
    await probe.eventually(()=>world.navigate(),{within:60_000,label:"Dashboard navigation"});
    if(mode==="baseline"){
      await user.see({text:"Sandbox startup check"},{timeoutMs:60_000});
      await user.click({role:"button",label:"Run Sandbox startup check"});
    }
    if(mode==="fixed"){
      const facts=await probe.eventually(()=>world.facts(),{within:60_000,label:"Result reached genuine MCP iframe",until:value=>value.receipts>0});
      expect(facts.retry).toBe(0);
      expect(facts.text).not.toContain("Sandbox proxy timed out");
      expect(facts.iframes.some(f=>f.width>200&&f.height>100)).toBe(true);
      expect(world.injection.requests.filter(r=>r.mode==="fixed"&&r.path.endsWith(".css"))).toHaveLength(0);
      await world.shot("02-fixed-css-delay",await user.screenshot());
    } else {
      const facts=await probe.eventually(()=>world.facts(),{within:60_000,label:"Real sandbox timeout with Retry",until:value=>value.text.includes("MCP_APP_SANDBOX_PROXY_TIMEOUT")});
      expect(facts.receipts).toBe(0);
      expect(facts.text.toLowerCase()).toContain("sandbox");
      await world.shot(mode==="baseline"?"01-baseline-css-timeout":"03-fixed-html-timeout",await user.screenshot());
      if(mode==="baseline")expect(world.injection.requests.some(r=>r.mode==="baseline"&&r.path.endsWith(".css")&&r.delayMs===40000)).toBe(true);
      if(mode==="failure"){
        expect(facts.retry).toBe(1);
        const callsBeforeRetry=await probe.toolCalls(world.witness);
        world.injection.set("recovery");
        await user.click({role:"button",text:"Retry"});
        const recovered=await probe.eventually(()=>world.facts(),{within:60_000,label:"Dashboard Retry restores tile",until:value=>value.receipts>0&&value.retry===0});
        expect(recovered.text.toLowerCase()).not.toContain("refresh failed");
        const callsAfterRetry=await probe.toolCalls(world.witness,{atLeast:callsBeforeRetry.length+1});
        expect(callsAfterRetry).toHaveLength(callsBeforeRetry.length+1);
        await world.shot("04-after-retry",await user.screenshot());
      }
    }
  }
  evidence.recordAssertionEvidence(baselineOnly?"Baseline dev dashboard times out with pending CSS":"Real isolated Electron dashboard bootstrap and owner-delegated Retry",JSON.stringify({output:world.output,requests:world.injection.requests,scope:baselineOnly?"Production source overlay c4356f0a2; isolated testkit Electron; real HTTP delay witness relayed via CDP; no production DOM replaced":"Baseline bootstrap byte control c4356f0a2, fixed renderer 2f88af7ae; isolated testkit Electron; real HTTP delay witness relayed via CDP; no production DOM replaced"}),true);
});
