import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolPart } from '@opencode-ai/sdk/v2/client';
import { parseDynamicToolUIPart } from './parse-tool-parts';
import { getAggregateRowFile,getWorkspacePathResolutions } from '@/lib/tool-aggregate';

test('completed native writes forward real destinations and requested-to-resolved provenance',()=>{
 const resolved=String.raw`C:\Users\Tester\Workspace\report.html`;
 const source:ToolPart={id:'part-write',sessionID:'session-report',messageID:'message-report',callID:'call-write',type:'tool',tool:'write',state:{status:'completed',input:{filePath:'/report.html',content:'hello'},output:'Wrote file successfully.',title:'report.html',metadata:{filepath:resolved,openworkWorkspacePaths:[{requested:'/report.html',resolved}]},time:{start:1,end:2}}};
 const part=parseDynamicToolUIPart(source);if(!part)throw Error('No write row');
 assert.deepEqual(getAggregateRowFile(part),{verb:'Wrote',path:resolved});assert.deepEqual(getWorkspacePathResolutions(part),[{requested:'/report.html',resolved}]);
});

test('completed native edits use the actual filediff target',()=>{
 const resolved=String.raw`D:\Opened\report.html`;
 const source:ToolPart={id:'part-edit',sessionID:'session-report',messageID:'message-report',callID:'call-edit',type:'tool',tool:'edit',state:{status:'completed',input:{filePath:'/report.html',oldString:'old',newString:'new'},output:'Edit applied successfully.',title:'report.html',metadata:{filediff:{file:resolved,patch:'',additions:1,deletions:1}},time:{start:1,end:2}}};
 const part=parseDynamicToolUIPart(source);if(!part)throw Error('No edit row');assert.equal(getAggregateRowFile(part)?.path,resolved);
});

test('answered questions forward what the person picked so the row can say it',()=>{
 const source:ToolPart={id:'part-question',sessionID:'session-q',messageID:'message-q',callID:'call-question',type:'tool',tool:'question',state:{status:'completed',input:{questions:[{question:'Ship it today?',header:'Ship',options:[{label:'Yes',description:''}]}]},output:'User has answered your questions: "Ship it today?"="Yes". You can now continue with the user\'s answers in mind.',title:'Asked 1 question',metadata:{answers:[['Yes']]},time:{start:1,end:2}}};
 const part=parseDynamicToolUIPart(source);if(!part)throw Error('No question row');
 assert.deepEqual(part.callProviderMetadata?.openwork?.questionAnswers,[['Yes']]);
});
