const axios = require('axios');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const log = require('../log-interface');
const fs = require("fs");

console.log("Note: this should be run from within the /scripts folder");

(async function(){
  log.info("Parsing HSK Lv1-6 Characters");
  const dom = await JSDOM.fromURL("http://huamake.com/1to6Lists.htm");
  const json = {}; let i = 0;
  Array.from(dom.window.document.body.children).forEach(htmlobj => {
    switch(htmlobj.tagName){
      case "H2":
        json["level"+ ++i] = {
          characters: [],
          vocabulary: []
        };
        break;
      case "A":
        json["level"+i].characters.push(String.fromCharCode(parseInt(htmlobj.href.split("%u")[1], 16)));
        break;
    }
  });
  Object.values(json).forEach(lvl => lvl.characters.sort());
  log.pass("Found HSK Characters");
  for(let i = 1; i <= 6; i ++){
    const dom = await JSDOM.fromURL(`http://huamake.com/newHSK${i}cnt.htm`);
      Array.from(dom.window.document.getElementsByTagName("span")).forEach(span => {
      if(span.children[span.children.length-1].tagName === "IMG" || i === 1)
        json["level"+i].vocabulary.push(Array.from(span.getElementsByTagName("a")).map(a => a.innerHTML).join(''))
    });
    log.pass(`Found ${json["level"+i].vocabulary.length} HSK Lv${i} Vocabulary`);
  }

  console.log(json);
  fs.writeFileSync("../data/hsk_data.json", JSON.stringify(json), 'utf8');
})();
