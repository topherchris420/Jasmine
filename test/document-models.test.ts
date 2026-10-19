import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/llm/mock.ts';
import { compareModels } from '../src/service/model-evals.ts';
import { createTestApp, fakeFetch } from './helpers.ts';

describe('local model features',()=>{
  it('measures explicit model comparison cases and rejects unbounded input',async()=>{
    const t=await createTestApp();
    try {
      const report=await compareModels(t.app,{models:[{}],cases:[{prompt:'Jasmine',expectedSubstring:'Jasmine'},{prompt:'Other',expectedSubstring:'absent-value'}]});
      expect(report.results.map(r=>r.passed)).toEqual([true,false]);
      expect(report.results[0]!.latencyMs).toBeGreaterThanOrEqual(0);
      await expect(compareModels(t.app,{models:[],cases:[]})).rejects.toMatchObject({code:'BAD_PAYLOAD'});
    }finally{await t.close();}
  });
  it('uses offline OCR as input to validated local-model document extraction',async()=>{
    const c=createCanvas(600,120),ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,600,120);ctx.fillStyle='black';ctx.font='44px sans-serif';ctx.fillText('JASMINE 8787',15,80);
    const http=fakeFetch(()=>new Response(new Uint8Array(c.toBuffer('image/png')).buffer,{headers:{'content-type':'image/png'}}));
    const model=new MockLLMProvider({respond:()=>'{"number":8787}'}),t=await createTestApp({fetch:http,llm:model});
    try{
      await t.app.deployments.deploy('extract',{nodes:[{id:'t',data:{nodeId:'graphqlNode',trigger:true,values:{}}},{id:'ocr',data:{nodeId:'agenticDocExtractionNode',values:{documentUrl:'https://fixture.invalid/image.png',outputFormat:'json',schema:{type:'object',properties:{number:{type:'integer'}},required:['number']},includeImages:true,joinPages:false,includeLayoutBlocks:true,confidenceScores:'word',thinking:'off'}}},{id:'r',data:{nodeId:'graphqlResponseNode',values:{outputMapping:'{{ocr.output}}'}}}],edges:[{source:'t',target:'ocr'},{source:'ocr',target:'r'}]});
      const result=await t.app.runs.executeWorkflow('extract',{});
      expect(result.status).toBe('success');
      expect(result.output).toMatchObject({structuredData:[{pageNumber:1,annotation:{number:8787}}],images:[{kind:'page'}]});
      expect(model.requests[0]!.messages[1]!.content).toContain('8787');
      expect(model.requests[0]!.thinking).toBe('off');
      expect((result.output as {extractedText:{blocks:unknown[]}[]}).extractedText[0]!.blocks.length).toBeGreaterThan(0);
    }finally{await t.close();}
  },30000);
});
