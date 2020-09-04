process.env.TZ = "UTC";
require('dotenv').config();

const assert = require('assert');
const Discord = require('discord.js');
const wanakana = require('wanakana');
const pyc = require('pinyin-convert');
const zyc = require('zhuyin');
const fs = require('fs');
const log = require('./log-interface');
const MongoClient = require('mongodb').MongoClient;

const client = new Discord.Client();
const MINIMUM_AGE = Date.now() - 7*24*60*60*1000;
const MAXIMUM_LESSON_SIZE = parseInt(process.env.MAXIMUM_LESSON_SIZE);
const WAIT_INTERVALS = process.env.WAIT_INTERVALS.split(',').map(int => parseInt(int));
const RKV_EMBED_COLORING = {"radical": 0x3498db, "kanji": 0x9b59b6, "vocab": 0xe91e63};
const SRS_STAGE_NAMING = ["Unknown", "Practiced", "Familiar", "Novice", "Intermediate", "Adept", "Proficient", "Specialist", "Expert", "Mastered"];
const SRS_STAGE_ICON = ["<:s0:733903368073773058>","<:s1:733903368023441468>","<:s2:733903368036024351>","<:s3:733903368010989639>","<:s4:733903367990149261>","<:s5:733903367893418126>", "<:s6:747167239198867476>", "<:s7:747167238926368871>", "<:s8:747169730066120754>", "<:s9:747169730082897990>"];
const RA = 0, KA = 1, VO = 2, HSK_RA = 3, SC = 4, HSK = 5;
const RKV = ["radical", "kanji", "vocab", "radical", "sc", "hsk"];
const TYPES = {
  /*
    id: index/ID
    nc: name capitalized (CamelCase?)
    lang: lang/topic it belongs to
    c: color
    w: weight
    db: mongo collection it belongs to
  */
  radical: {
    id: 0,
    nc: "Radical",
    lang: "jp",
    c: 0x3498db,
    w: 1,
    db: "radical"
  },
  kanji: {
    id: 1,
    nc: "Kanji",
    lang: "jp",
    c: 0x9b59b6,
    w: 2,
    db: "kanji"
  },
  vocab: {
    id: 2,
    nc: "Vocabulary",
    lang: "jp",
    c: 0xe91e63,
    w: 2,
    db: "vocab"
  },
  hskr: {
    id: 3,
    nc: "Radical",
    lang: "hsk",
    c: 0x3498db,
    w: 1,
    db: "radical"
  },
  sc: {
    id: 4,
    nc: "Hanzi (Simplified)",
    lang: "hsk",
    c: 0x9b59b6,
    w: 2,
    db: "sc"
  },
  hsk: {
    id: 5,
    nc: "Vocabulary",
    lang: "hsk",
    c: 0xe91e63,
    w: 2,
    db: "hsk"
  },
  tc: {
    id: 7,
    nc: "Hanzi (Traditional)",
    lang: "tc",
    c: 0x9b59b6,
    w: 2,
    db: "tc"
  },
};
Object.keys(TYPES).forEach(t => TYPES[TYPES[t].id] = Object.assign({txt: t}, TYPES[t])); // console.log(TYPES);
const ACRONYM = {
  "py": "pinyin",
  "en": "meaning"
}
const NOT_STARTED_YET = -1, LEARN = 0, REVIEW = 1;
let db;
const lessons = {};
const timeouts = {};
const intervals = {};

function Field (name, value, inline){
  this.name = name || "uh something broke";
  this.value = value || "n/a";
  this.inline = !!inline;
}
function msToHMS(ms){
  return Math.floor(ms/3.6e6).toString().padStart(2, 0)+":"+Math.floor(ms/6e4%60).toString().padStart(2, 0)+":"+Math.floor(ms/1e3%60).toString().padStart(2, 0);
}
function randomShuffle(array){
  for (let i = array.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}
function idFromMention(mention){
  return mention.replace('<@', '').replace('!', '').replace('>', '');
}
function User(){
  this.radical = {};
  this.kanji = {};
  this.vocab = {};
  this.next = {
    radical: 2,
    kanji: 1,
    vocab: 1
  };
  this.lessons = {};
  this.xp = 0;
  this.xpMax = 10;
  this.nextBonus = Date.now();
  this.level = 1;
}
function nextLeveLThreshold(oldxpMax){
  return Math.ceil(Math.min((1000-oldxpMax%1000)+oldxpMax+500,(oldxpMax+oldxpMax**1.04))/20)*10;
}
function SRSObj(){
  this.level = 0;
  this.levelOld = 0;
  this.incorrect = 0;
}
function queuedLesson(char, type, lessonType, time){
  this.char = char;
  this.type = type;
  this.time = time;
  this.lessonType = lessonType;
}
function newSRSLevel(SRSObj, correct){
  return correct ? SRSObj.levelOld + 1 : Math.max(0, SRSObj.levelOld - (Math.ceil(SRSObj.incorrect/2) * (SRSObj.levelOld >= 5 ? 2 : 1)));
}
function formatLv(lv){
  return `${String.fromCharCode(945+Math.floor(lv/5))}-${"i ii iii iv v vi vii viii ix x".split(' ')[lv%5]}`;
}

function Lesson(uid, lang, message, contents){
  this.id = uid;
  this.lang = lang;
  this.message = message;
  this.channel = message.channel;
  this.sentPrompt = false;
  this.contents = [];
  for(let i = contents.length-1; i >= 0; i --)
    if(contents[i].lessonType === LEARN)
      this.contents.push(contents.splice(i, 1)[0]);
  this.contents.push(...randomShuffle(contents));
  this.correct = 0;
  this.attempts = 0;
  this.size = this.contents.length;
  this.xpGain = 0;
  this.announcement = "";
  this.prevState = NOT_STARTED_YET;
}
Lesson.prototype.advance = async function(message){
  if(this.contents.length){
    const currentLesson = this.contents[0];
    // console.log(currentLesson); // DEBUG
    this.prevState = currentLesson.lessonType;
    if(currentLesson.lessonType === LEARN){
      const lessonMessage = await (async function(){
        const res = await db.collection(RKV[currentLesson.type]).findOne({_id: currentLesson.char});
        switch(currentLesson.type){
          case RA:
          case HSK_RA:
            return message.channel.send({embed: {
              title: `New Radical Lesson`,
              fields: [
                new Field("Radical", currentLesson.char),
                new Field("Definition", res.meaning),
                new Field("References", `[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(currentLesson.char)})`)
              ],
              color: 0x3498db,
              thumbnail: {
                url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(currentLesson.char).replace(/%/g, '')}.png`
              }
            }});
            break;
          case KA:
            return message.channel.send({embed: {
              title: `New Kanji Lesson`,
              fields: [
                new Field("Kanji", `${currentLesson.char}\u3010${res.radical}\u3011`, true),
                new Field("Onyomi", res.onyomi.replace(/,/g, '\u3001'), true),
                new Field("Kunyomi", res.kunyomi.replace(/,/g, '\u3001'), true),
                new Field("Definition", res.meaning.replace(/,/g, ', ')),
                new Field("Mnemonic/Hint", res.mnemonic),
                new Field("Examples", res.examples.map(ex => ex.split('|')[0]).join('\n'), true),
                new Field("Meaning", res.examples.map(ex => ex.split('|')[1]).join('\n'), true),
                new Field("References", `[Jisho](https://jisho.org/search/${encodeURI(currentLesson.char)})\u30fb[KanjiAlive](https://app.kanjialive.com/${encodeURI(currentLesson.char)})\u30fb[Tangorin](https://tangorin.com/kanji/${encodeURI(currentLesson.char)})\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(currentLesson.char)})`)
              ],
              color: 0x9b59b6,
              thumbnail: {
                url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(currentLesson.char).replace(/%/g, '')}.png`
              }
            }});
            break;
          case VO:
            const VO_EMBED = {
              embed: {
                title: `New Vocabulary Lesson: ${currentLesson.char}`,
                description: `Part of Speech: ${res.lexicalClass}`,
                fields: [
                  new Field("Meaning", res.meaning.replace(/,/g, ", "), true),
                  new Field("Reading", res.reading.replace(/,/g, ", "), true),
                  new Field("Meaning Explanation", res.meaningExplanation || "n/a"),
                  new Field("Reading Explanation", res.readingExplanation || "n/a"),
                  new Field("References", `[Jisho](https://jisho.org/search/${encodeURI(currentLesson.char)})\u30fb[Tangorin](https://tangorin.com/definition/${encodeURI(currentLesson.char)})\u30fb[WaniKani](https://www.wanikani.com/vocabulary/${encodeURI(currentLesson.char)})\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(currentLesson.char)})`)
                ],
                color: 0xe91e63
              }
            };
            if(res.recording !== null) VO_EMBED.files = [res.recording.split(',')[0]];
            return message.channel.send(VO_EMBED);
            break;
          case SC:
            const SC_EMBED = {embed: {
              title: `New Hanzi Lesson`,
              fields: [
                new Field("Hanzi", `${currentLesson.char}\u3010${res.ra}\u3011`, true),
                new Field("Pinyin", '`'+res.py.join('\u3001')+'`', true),
                new Field("Zhuyin", (await zyc(res.py.join(' '))).join('\u3001').replace(/`/g, "\\`"), true),
                new Field("Definition", res.en),
                new Field("Context Examples", res.ex.map(ex => ex.replace('\u3010', "\u3010`").replace('\u3011|', "`\u3011*").trim() + '*').join('\n') || "n/a"),
                new Field("References", `[Cojak](http://www.cojak.org/index.php?function=code_lookup&term=${currentLesson.char.charCodeAt(0).toString(16).toUpperCase()})\u30fb[MDBG](https://www.mdbg.net/chinese/dictionary?wdqb=${encodeURI(currentLesson.char)})\u30fb[Purple Culture](https://www.purpleculture.net/dictionary-details/?word=${encodeURI(currentLesson.char)})\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(currentLesson.char)})`)
              ],
              color: 0x9b59b6
            }};
            if(res.img) SC_EMBED.embed.thumbnail = { url: res.img };
            else {
              SC_EMBED.files = [{
                attachment: `https://dictionary.writtenchinese.com/giffile.action?&localfile=true&fileName=${encodeURI(encodeURI(currentLesson.char))}.gif`,
                name: `so.gif`
              }];
            }
            embed = await message.channel.send(SC_EMBED);
            if(!res.img) await db.collection('sc').updateOne({_id: currentLesson.char}, {$set: { img: embed.attachments.array()[0].url }}); // don't update if one exists already
            return embed;
            break;
          case HSK:
            return message.channel.send({
              embed: {
                title: `New Vocabulary Lesson`,
                fields: [
                  new Field("Term", currentLesson.char, true),
                  new Field("Pinyin", '`'+res.py+'`', true),
                  new Field("Zhuyin", (await zyc(res.py)).join('\n').replace(/`/g, "\\`"), true),
                  new Field("Definition", res.en),
                  new Field("Examples", res.ex.map(ex => ex.replace('\u3010', '\n').replace('\u3011', '').replace('|', '\n*"').trim() + '"*').join('\n\n') || "n/a", true),
                  new Field("References", `[MDBG](https://www.mdbg.net/chinese/dictionary?wdqb=${encodeURI(currentLesson.char)})\u30fb[Purple Culture](https://www.purpleculture.net/dictionary-details/?word=${encodeURI(currentLesson.char)})\u30fb[Written Chinese](https://dictionary.writtenchinese.com/#sk=${encodeURI(currentLesson.char)}&svt=pinyin)\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(currentLesson.char)})`)
                ],
                color: 0xe91e63
              },
              files: ["https://dictionary.writtenchinese.com/sounds/" + (await pyc(res.py)).split(' ').map(p => p.match(/[1-4]$/) ? p : p+5).join('') + ".mp3"]
            });
            break;
        }
      })();
      lessonMessage.react("\u23ed\ufe0f");
      this.message = lessonMessage;
      this.contents.push(new queuedLesson(currentLesson.char, currentLesson.type, REVIEW, currentLesson.time));
      this.contents.splice(0, 1);
    }else{ // else type REVIEW
      if(this.sentPrompt){
        this.sentPrompt = false;
        const res = await db.collection(RKV[currentLesson.type]).findOne({_id: currentLesson.char});
        let correct = false, solution = "[something probably broke]";
        switch(currentLesson.type){
          case RA:
          case HSK_RA:
            if(res.meaning.toLowerCase().split(', ').includes(message.content.trim().toLowerCase())) correct = true;
            solution = res.meaning.toLowerCase();
            break;
          case KA:
            if(wanakana.toRomaji(res[currentLesson.requested.text]).split(',').includes(wanakana.toRomaji(message.content.trim().toLowerCase()))) correct = true;
            solution = `One of the following: ${res[currentLesson.requested.text].replace(/,/g, currentLesson.requested.text === "meaning" ? ", " : '\u3001')}` + (currentLesson.requested.text !== "meaning" ? `\nAlternative: ${wanakana.toRomaji(res[currentLesson.requested.text]).replace(/,/g, ", ")}` : "");
            break;
          case VO:
            if(wanakana.toRomaji(res[currentLesson.requested.text]).split(',').includes(wanakana.toRomaji(message.content.trim().toLowerCase()))) correct = true;
            solution = `One of the following: ${res[currentLesson.requested.text].replace(/,/g, currentLesson.requested.text === "meaning" ? ", " : '\u3001')}` + (currentLesson.requested.text !== "meaning" ? `\nAlternative: ${wanakana.toRomaji(res[currentLesson.requested.text]).replace(/,/g, ", ")}` : "");
            break;
          case SC:
            if(currentLesson.requested.text === "en"){
              res.en = res.en.replace(/[\(\)]/g, "") + "; " + [...(res.en.replace(/ or /g, "; ").replace(/\([^\)]+\)/g, "").split("; ")), ...(res.en.split('; ').filter(str => str.includes('for')).map(str => str.split('for')[0].trim()))].filter(c => c.length).join("; ");
              if(res.en.match(/classifier (for|indicating)/)) res.en = res.en.trim() + "; classifier";
              if(res.en.split('; ').map(ans => ans.trim()).includes(message.content.trim().replace(/[\(\)]/g, ""))) correct = true;
              solution = `One of the following: ${res.en}`;
            }else{
              const str = message.content.trim().toLowerCase();
              const alt = (await pyc(res.py.join(', ')));
              if(res.py.includes(str) || alt.split(', ').includes(str)) correct = true;
              else solution = `One of the following: ${res.py.join('\u3001')}\nAlternative: ${alt}`;
            }
            break;
          case HSK:
            if(currentLesson.requested.text === "en"){
              if(res.en.toLowerCase().split('; ').includes(message.content.trim().toLowerCase())) correct = true;
              solution = `One of the following: ${res.en}`;
            }else{
              const str = message.content.trim().toLowerCase();
              const alt = (await pyc(res.py));
              if(res.py.includes(str) || alt.split(', ').includes(str)) correct = true;
              else solution = `One of the following: ${res.py}\u3001${alt}`;
            }
            break;
        }
        const usr = await db.collection('user').findOne({_id: this.id});
        if(correct){
          this.correct ++;
          {
            const xpGain = 2+Math.ceil(Math.random()*3);
            this.xpGain += xpGain;
            usr.xp += xpGain; // 2 + [1,3] => [3,5]
          }
          if(currentLesson.todo && currentLesson.todo.length > 1){
            // there are more than one todo items (if there's one, then you just completed that one)
            currentLesson.todo.splice(currentLesson.requested.index, 1); // remove from todo items and assign new requested one
            const i = ~~(Math.random()*currentLesson.todo.length);
            currentLesson.requested = {
              index: i,
              text: currentLesson.todo[i]
            };
            // then swap to move it somewhere else
            if(this.contents.length > 1){ // only do swap if there's more than one
              const i = Math.min(this.contents.length-1, ~~(2+Math.random()*(this.contents.length-2))); // random lesson item to swap with
              const temp = this.contents[i];
              this.contents[i] = this.contents[0];
              this.contents[0] = temp;
            }
          }else{
            for(let i = 0; i < usr.lessons[this.lang].length; i ++){
              // if(i === MAXIMUM_LESSON_SIZE) throw "missing lessons?";
              if(usr.lessons[this.lang][i].char === currentLesson.char && usr.lessons[this.lang][i].type === currentLesson.type){
                const PAYLOAD = {};
                const SRSDATA = usr[TYPES[currentLesson.type].txt][currentLesson.char];
                SRSDATA.level = newSRSLevel(SRSDATA, !currentLesson.gotWrongInSession);
                SRSDATA.levelOld = SRSDATA.level;
                SRSDATA.incorrect = 0;
                PAYLOAD[`${TYPES[currentLesson.type].txt}.${currentLesson.char}`] = SRSDATA;
                usr.lessons[this.lang].splice(i, 1);
                if(SRSDATA.level < 9) usr.lessons[this.lang].push(new queuedLesson(currentLesson.char, currentLesson.type, SRSDATA.level > 1 ? REVIEW : LEARN, Date.now() + WAIT_INTERVALS[SRSDATA.level]));
                if(SRSDATA.level === 5){
                  let pass = true, checks;
                  switch(currentLesson.type){
                    case RA:
                      checks = (await db.collection('radical').findOne({_id: `lv${usr.next.kanji}`})).content;
                      for(let i = 0; i < checks.length; i ++){
                        if(!usr.radical[checks[i]] || usr.radical[checks[i]].level < 5){
                          pass = false;
                          log.error(`FAILED CHECK: Radical ${checks[i]} is at level ${usr.radical[checks[i]] ? usr.radical[checks[i]].level : "DNE"}`);
                          break;
                        }
                      }
                      if(pass){
                        log.info(`User ${usr._id} passed Radical stage ${usr.next.kanji}`);
                        this.announcement = `**You passed Stage ${formatLv(usr.next.radical-2)} Radicals!** (New kanji unlocked!)`;
                        (await db.collection('kanji').findOne({_id: `lv${usr.next.kanji}`})).content.forEach(char => {
                          PAYLOAD[`kanji.${char}`]= new SRSObj();
                          usr.lessons[this.lang].push(new queuedLesson(char, KA, LEARN, Date.now()));
                        });
                        PAYLOAD[`next.kanji`] = usr.next.kanji + 1;
                      }
                      break;
                    case KA:
                      checks = (await db.collection('kanji').findOne({_id: `lv${usr.next.vocab}`})).content;
                      for(let i = 0; i < checks.length; i ++){
                        if(!usr.kanji[checks[i]] || usr.kanji[checks[i]].level < 5){
                          pass = false;
                          log.error(`FAILED CHECK: Kanji ${checks[i]} is at level ${usr.kanji[checks[i]] ? usr.kanji[checks[i]].level : "DNE"}`);
                          break;
                        }
                      }
                      if(pass){
                        log.info(`User ${usr._id} passed Kanji stage ${usr.next.vocab}`);
                        this.announcement = `**You passed Stage ${formatLv(usr.next.kanji-2)} Kanji!**`;
                        (await db.collection('vocab').findOne({_id: `lv${usr.next.vocab}`})).content.forEach(char => {
                          PAYLOAD[`vocab.${char}`]= new SRSObj();
                          usr.lessons[this.lang].push(new queuedLesson(char, VO, LEARN, Date.now()));
                        });
                        PAYLOAD[`next.vocab`] = usr.next.vocab + 1;
                        const nextRadicals = await db.collection('radical').findOne({_id: `lv${usr.next.radical}`});
                        nextRadicals.content.forEach(char => {
                          PAYLOAD[`radical.${char}`]= new SRSObj();
                          usr.lessons[this.lang].push(new queuedLesson(char, RA, LEARN, Date.now()));
                        });
                        PAYLOAD[`next.radical`] = usr.next.radical + 1;
                        if(nextRadicals.content.length === 0){
                          (await db.collection('kanji').findOne({_id: `lv${usr.next.kanji}`})).content.forEach(char => {
                            PAYLOAD[`kanji.${char}`]= new SRSObj();
                            usr.lessons[this.lang].push(new queuedLesson(char, KA, LEARN, Date.now()));
                          });
                          PAYLOAD[`next.kanji`] = usr.next.kanji + 1;
                          this.announcement += " (New kanji and vocabulary unlocked!)";
                        }else this.announcement += " (New radicals and vocabulary unlocked!)";
                      }
                      break;
                    case HSK_RA:
                      checks = (await db.collection('radical').findOne({_id: `lv${usr.next.sc}`})).scn;
                      for(let i = 0; i < checks.length; i ++){
                        if(!usr.hskr[checks[i]] || usr.hskr[checks[i]].level < 5){
                          pass = false;
                          log.error(`FAILED CHECK: Radical [HSK] ${checks[i]} is at level ${usr.hskr[checks[i]] ? usr.hskr[checks[i]].level : "DNE"}`);
                          break;
                        }
                      }
                      if(pass){
                        log.info(`User ${usr._id} passed Radical stage ${usr.next.sc}`);
                        this.announcement = `**You passed Stage ${formatLv(usr.next.hskr-2)} Radicals!** (New hanzi unlocked!)`;
                        (await db.collection('sc').findOne({_id: `lv${usr.next.sc}`})).content.forEach(char => {
                          PAYLOAD[`sc.${char}`]= new SRSObj();
                          usr.lessons[this.lang].push(new queuedLesson(char, SC, LEARN, Date.now()));
                        });
                        PAYLOAD[`next.sc`] = usr.next.sc + 1;
                      }
                      break;
                    case SC:
                      checks = (await db.collection('sc').findOne({_id: `lv${usr.next.hsk}`})).content;
                      for(let i = 0; i < checks.length; i ++){
                        if(!usr.sc[checks[i]] || usr.sc[checks[i]].level < 5){
                          pass = false;
                          log.error(`FAILED CHECK: Hanzi ${checks[i]} is at level ${usr.sc[checks[i]] ? usr.sc[checks[i]].level : "DNE"}`);
                          break;
                        }
                      }
                      if(pass){
                        log.info(`User ${usr._id} passed Hanzi stage ${usr.next.hsk}`);
                        this.announcement = `**You passed Stage ${formatLv(usr.next.sc-2)} Hanzi!**`;
                        (await db.collection('hsk').findOne({_id: `lv${usr.next.hsk}`})).content.forEach(char => {
                          PAYLOAD[`hsk.${char}`]= new SRSObj();
                          usr.lessons[this.lang].push(new queuedLesson(char, HSK, LEARN, Date.now()));
                        });
                        PAYLOAD[`next.hsk`] = usr.next.hsk + 1;
                        const nextRadicals = await db.collection('radical').findOne({_id: `lv${usr.next.hskr}`});
                        nextRadicals.scn.forEach(char => {
                          PAYLOAD[`hskr.${char}`]= new SRSObj();
                          usr.lessons[this.lang].push(new queuedLesson(char, HSK_RA, LEARN, Date.now()));
                        });
                        PAYLOAD[`next.hskr`] = usr.next.hskr + 1;
                        if(nextRadicals.content.length === 0){
                          (await db.collection('sc').findOne({_id: `lv${usr.next.sc}`})).content.forEach(char => {
                            PAYLOAD[`sc.${char}`]= new SRSObj();
                            usr.lessons[this.lang].push(new queuedLesson(char, SC, LEARN, Date.now()));
                          });
                          PAYLOAD[`next.sc`] = usr.next.sc + 1;
                          this.announcement += " (New hanzi and vocabulary unlocked!)";
                        }else this.announcement += " (New radicals and vocabulary unlocked!)";
                      }
                      break;
                  }
                }
                usr.lessons[this.lang].sort((a,b) => a.time - b.time);
                PAYLOAD[`lessons.${this.lang}`] = usr.lessons[this.lang];
                // console.log(PAYLOAD);
                await db.collection('user').updateOne({_id: usr._id}, {$set: PAYLOAD});
                this.contents.splice(0, 1);
                break; // we found where it's located in lessons and we done here
              }
            }
          }
          if(usr.xp >= usr.xpMax){ // check if level up
            usr.xp -= usr.xpMax;
            usr.xpMax = nextLeveLThreshold(usr.xpMax);
            usr.level ++;
          }
          await db.collection('user').updateOne({_id: usr._id}, {$set: {
            xp: usr.xp,
            xpMax: usr.xpMax,
            level: usr.level
          }});
          message.react("\u2705").then(() => this.advance(message));
        }else{ // incorrect response
          if(this.contents.length > 1){ // only do swap if there's more than one
            const i = Math.min(this.contents.length-1, ~~(2+Math.random()*(this.contents.length-2))); // random lesson item to swap with
            const temp = this.contents[i];
            this.contents[i] = this.contents[0];
            this.contents[0] = temp;

            const PAYLOAD = {};
            const SRSDATA = usr[TYPES[currentLesson.type].txt][currentLesson.char];
            SRSDATA.incorrect ++;
            SRSDATA.level = newSRSLevel(SRSDATA);
            PAYLOAD[`${TYPES[currentLesson.type].txt}.${currentLesson.char}`] = SRSDATA;
            await db.collection('user').updateOne({_id: usr._id}, {$set: PAYLOAD});
          }
          const EMBED = {
            title: "Incorrect Response",
            description: `Prompt: The **${(currentLesson.requested && (ACRONYM[currentLesson.requested.text] || currentLesson.requested.text)) || "meaning"}** of ${currentLesson.char}`,
            fields: [
              new Field("Submission", "```\n"+message.content+"\n```"),
              new Field("Solution", "```\n"+solution+"\n```")
            ],
            timestamp: Date.now(),
            color: 0xe74c3c
          };
          if(currentLesson.type === RA || currentLesson.type === KA){
              EMBED.thumbnail = {
              url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(currentLesson.char).replace(/%/g, '')}.png`
            };
          }
          currentLesson.gotWrongInSession = true;
          message.channel.send({embed: EMBED}).then(message => {
            this.prevState = LEARN;
            this.message = message;
            message.react("\u23ed\ufe0f");
          });
        }
        this.attempts ++;
      }else{ // have not sent the prompt yet
        this.sentPrompt = true;
        switch(currentLesson.type){
          case RA:
          case HSK_RA:
            message.channel.send({embed: {
              title: currentLesson.char,
              description: "Name the radical's meaning.",
              color: 0x3498db,
              thumbnail: {
                url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(currentLesson.char).replace(/%/g, '')}.png`
              }
            }});
            break;
          case KA:
            if(currentLesson.requested === undefined){
              res = await db.collection('kanji').findOne({_id: currentLesson.char});
              currentLesson.todo = ["meaning"];
              if(res.onyomi && !res.kunyomi) currentLesson.todo.push("onyomi");
              if(res.kunyomi && !res.onyomi) currentLesson.todo.push("kunyomi");
              const i = ~~(Math.random()*currentLesson.todo.length);
              currentLesson.requested = {
                index: i,
                text: currentLesson.todo[i]
              };
            }
            message.channel.send({embed: {
              title: currentLesson.char,
              description: `Name the kanji's **${currentLesson.requested.text}**`,
              color: 0x9b59b6,
              thumbnail: {
                url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(currentLesson.char).replace(/%/g, '')}.png`
              }
            }});
            break;
          case VO:
            if(currentLesson.requested === undefined){
              res = await db.collection('kanji').findOne({_id: currentLesson.char});
              currentLesson.todo = ["meaning", "reading"];
              const i = ~~(Math.random()*currentLesson.todo.length);
              currentLesson.requested = {
                index: i,
                text: currentLesson.todo[i]
              };
            }
            message.channel.send({embed: {
              title: `${currentLesson.char} [${currentLesson.requested.text === "meaning" ? "📔" : "🗣️"}]`,
              description: `Name this vocabulary's **${currentLesson.requested.text}**`,
              color: 0xe91e63
            }});
            break;
          case SC:
            if(currentLesson.requested === undefined){
              currentLesson.todo = [/*"en", */"py"];
              const i = ~~(Math.random()*currentLesson.todo.length);
              currentLesson.requested = {
                index: i,
                text: currentLesson.todo[i]
              };
            }
            message.channel.send({embed: {
              title: `${currentLesson.char} [${ACRONYM[currentLesson.requested.text]}]`,
              description: `Name this hanzi's **${ACRONYM[currentLesson.requested.text]}**`,
              color: 0x9b59b6
            }});
            break;
          case HSK:
            if(currentLesson.requested === undefined){
              currentLesson.todo = ["en", "py"];
              const i = ~~(Math.random()*currentLesson.todo.length);
              currentLesson.requested = {
                index: i,
                text: currentLesson.todo[i]
              };
            }
            message.channel.send({embed: {
              title: `${currentLesson.char} [${currentLesson.requested.text === "en" ? "📔" : "🗣️"}]`,
              description: `Name this term's **${ACRONYM[currentLesson.requested.text]}**`,
              color: 0xe91e63
            }});
            break;
        }
      }
    }
  }else{
    const usr = await db.collection('user').findOne({_id: this.id});
    const now = Date.now();
    if(usr.nextBonus === undefined) usr.nextBonus = 0;
    if(now > usr.nextBonus){
      const bonusXP = Math.ceil(this.xpGain/2);
      usr.xp += bonusXP;
      if(usr.xp >= usr.xpMax){ // check if level up
        usr.xp -= usr.xpMax;
        usr.xpMax = nextLeveLThreshold(usr.xpMax);
        usr.level ++;
      }
      this.announcement += (this.announcement.length ? "\n" : "") + `Gained +${bonusXP} bonus XP for first lesson of the day!`;
      await db.collection('user').updateOne({_id: usr._id}, {$set: {
        xp: usr.xp,
        xpMax: usr.xpMax,
        level: usr.level,
        nextBonus: now-now%86400000+86400000
      }});
    }
    this.terminate(message);
    refresh();
  }
  /* const cp = Object.assign({}, this);
  delete cp.channel;
  delete cp.message;
  console.log(cp); */ // DEBUG
};
Lesson.prototype.terminate = function(message){
  message.channel.send({embed: {
    title: "Lesson Complete!",
    description: `Accuracy: ${(this.correct/this.attempts*100).toFixed(1)}% (${this.correct} / ${this.attempts})\nTerms in Session: ${this.size}\n*+${this.xpGain}XP*${this.announcement ? "\n\n"+this.announcement : ""}`,
    color: 0x2ecc71
  }});
  delete lessons[this.id];
};

const cmds = {
  help: {
    desc: "list command info",
    params: "(command)",
    exec: (message, query) => {
      if(query){
        if(cmds[query]){
          message.channel.send({embed: {
            title: `${process.env.PREFIX}${query} ${cmds[query].params || ""}`,
            description: cmds[query].desc
          }});
        }else message.channel.send({embed: {description: `No command called ${query} found.`}});
      }else{
        message.channel.send({embed: {
          title: "Commands",
          description: helpcmdtext
        }})
      }
    }
  },
  invite: {
    desc: "Returns a link to add this bot to your server.",
    exec: (message) => {
      message.channel.send({embed: {
        color: 0x206694,
        title: "Invite link",
        url: 'https://discordapp.com/oauth2/authorize?client_id=733011559932231732&scope=bot&permissions=384064',
        description: 'Click the link above to add this bot to your server.'
      }});
    }
  },
  register: {
    desc: "create acc",
    exec: (message, param) => {
      db.collection('user').findOne({_id: message.author.id}).then(async usr => {
        if(usr !== null && param !== "force") return message.react("\u2049\ufe0f");
        if(usr !== null) await db.collection('user').deleteOne({_id: message.author.id});
        db.collection('user').updateOne({_id: message.author.id}, {$set: new User()}, {upsert: true}).then(() => {
          log.info(`Created account for ${message.author.tag}`);
          message.react("\uD83C\uDD97");
          message.author.send({embed: {
            title: "Account Creation Successful!",
            description: `Use *\`${process.env.PREFIX}initialize\`* to get your first lessons.\nUse *\`${process.env.PREFIX}lesson\`* after that to view it.\nUse *\`${process.env.PREFIX}lesson start\`* to start the lesson immediately.`,
            color: 0x2ecc71,
            timestamp: Date.now()
          }})
        });
      })
    }
  },
  profile: {
    desc: "display basic user information",
    params: "[userMention or ID]",
    exec: async (message, user) => {
      const usr = await db.collection('user').findOne({_id: (user && idFromMention(user)) || message.author.id});
      if(usr === null) return message.react("\u2049\ufe0f");
      console.log(usr);
      //let p = "";
      //(`${Object.keys(usr.radical).map(char => usr.radical[char].level < 6 ? `${char} ${SRS_STAGE_ICON[usr.radical[char].level]}` : "").filter(str => str.length).join('\n')}\n${Object.keys(usr.kanji).map(char => usr.kanji[char].level < 6 ? `${char} ${SRS_STAGE_ICON[usr.kanji[char].level]}` : "").filter(str => str.length).join('\n')}\n${Object.keys(usr.vocab).map(char => usr.vocab[char].level < 6 ? `${char} ${SRS_STAGE_ICON[usr.vocab[char].level]}` : "").filter(str => str.length).join('\n')}`).split('\n').forEach((str,i) => p += `${str}    ${i%5?"\n":""}`);
      const EMBED_FIELDS = [new Field("Milestones", `\n`)];

      if(usr.lessons.jp){
        EMBED_FIELDS[0].value += `Radical ${formatLv(usr.next.radical-2)}\n${usr.next.kanji > 1 ? `Kanji ${formatLv(usr.next.kanji-2)}` : ""}\n${usr.next.vocab > 1 ? `Vocabulary ${formatLv(usr.next.vocab-2)}` : ""}`;
        EMBED_FIELDS.push(new Field(`Radical Progress`, (await db.collection('radical').findOne({_id: `lv${usr.next.radical-1}`})).content.map(char => `${char} ${SRS_STAGE_ICON[Math.min(usr.radical[char].level, SRS_STAGE_ICON.length)]}`).join('  ')));
        if(usr.next.kanji > 1) EMBED_FIELDS.push(new Field(`Kanji Progress`, (await db.collection('kanji').findOne({_id: `lv${usr.next.kanji-1}`})).content.map(char => `${char} ${SRS_STAGE_ICON[Math.min(usr.kanji[char].level, SRS_STAGE_ICON.length)]}`).join('  ')));
        if(usr.next.vocab > 1){
          EMBED_FIELDS.push(new Field(`Vocabulary Progress`, "", true), new Field(".", "", true), new Field(".", "", true));
          (await db.collection('vocab').findOne({_id: `lv${usr.next.vocab-1}`})).content.map(char => `${char.padEnd(4, '\u3000')} ${SRS_STAGE_ICON[Math.min(usr.vocab[char].level, SRS_STAGE_ICON.length)]}`).sort().forEach((prog,i) => EMBED_FIELDS[3+i%3].value += prog+"\n");
        }
      }
      if(usr.lessons.hsk){
        EMBED_FIELDS[0].value += `Radical ${formatLv(usr.next.hskr-2)}\n${usr.next.sc > 1 ? `Hanzi (Simplified) ${formatLv(usr.next.sc-2)}` : ""}\n${usr.next.hsk > 1 ? `Vocabulary (HSK) ${formatLv(usr.next.hsk-2)}` : ""}`;
        EMBED_FIELDS.push(new Field(`Radical Progress`, (await db.collection('radical').findOne({_id: `lv${usr.next.hskr-1}`})).scn.map(char => `${char} ${SRS_STAGE_ICON[Math.min(usr.hskr[char].level, SRS_STAGE_ICON.length)]}`).join('  ')));
        if(usr.next.sc > 1) EMBED_FIELDS.push(new Field(`Hanzi (Simplified) Progress`, (await db.collection('sc').findOne({_id: `lv${usr.next.sc-1}`})).content.map(char => `${char} ${SRS_STAGE_ICON[Math.min(usr.sc[char].level, SRS_STAGE_ICON.length)]}`).join('  ')));
        if(usr.next.hsk > 1){
          EMBED_FIELDS.push(new Field(`Vocabulary`, "", true), new Field("(HSK)", "", true), new Field("Progress", "", true));
          (await db.collection('hsk').findOne({_id: `lv${usr.next.hsk-1}`})).content.map(char => `${char.padEnd(4, '\u3000')} ${SRS_STAGE_ICON[Math.min(usr.hsk[char].level, SRS_STAGE_ICON.length)]}`).sort().forEach((prog,i) => EMBED_FIELDS[EMBED_FIELDS.length-3+i%3].value += prog+"\n");
        }
      }
      console.log(EMBED_FIELDS)
      // console.log(EMBED_FIELDS);
      EMBED_FIELDS.forEach(E => E.value = E.value.replace("n/a", "").substring(0, 1023));
      message.channel.send({embed: {
        title: `${client.users.cache.get(usr._id).username} (Lv ${usr.level})`,
        description: `*${usr.xpMax-usr.xp}xp to next level*`,
        fields: EMBED_FIELDS,
        color: 0x1abc9c,
        thumbnail: {
          url: client.users.cache.get(usr._id).avatarURL()
        }
      }});
    }
  },
  progress: {
    desc: "display user's progress on a particular item (mostly for debug)",
    params: "[type] [query]",
    exec: async (message, type, query) => {
      if(!type) return message.channel.send("Missing type. [radical|kanji|vocab]");
      if(type !== "radical" && type !== "kanji" && type !== "vocab") return message.channel.send("Invalid type. [radical|kanji|vocab]");
      if(!query) return message.channel.send("Missing query.");
      try {
        const srs = (await db.collection('user').findOne({_id: message.author.id}))[type][query];
        console.log(srs);
        message.channel.send({embed: {
          title: query,
          description: `Progress: ${SRS_STAGE_ICON[Math.min((srs && srs.level) || 0, SRS_STAGE_ICON.length)]}`,
          // ${SRS_STAGE_NAMING[(srs && srs.level) || 0]}
          color: RKV_EMBED_COLORING[type]
        }});
      } catch(e){log.error(e)}
    }
  },
  lookup: { /* rewrite to return a promise if i ever have to cuz returning into an async function doesn't work */
    alias: ["l"],
    desc: "display query's dictionary details",
    params: "[type] [characater]",
    exec: (message, type, query) => {
      if(!type) return message.channel.send(`Missing type. [${Object.keys(TYPES).join('|')}]`);
      if(!TYPES[type]) return message.channel.send(`Invalid type. [${Object.keys(TYPES).join('|')}]`);
      if(!query) return message.channel.send("Missing query.");
      db.collection(type).findOne({_id: query}).then(async res => {
        if(res === null) return message.channel.send(`**${query}** was not found in **${type}**.`);
        console.log(res);
        if(query.startsWith("lv")){
          message.channel.send({embed: {
            title: `Stage ${formatLv(parseInt(query.replace("lv", ''))-1)} ${TYPES[type].nc}`,
            description: res.content.join('\u3001'),
            color: RKV_EMBED_COLORING[type]
          }})
        }else{
          let embed;
          switch(type){
            case "radical":
              return message.channel.send({embed: {
                title: `${query} - ${res.meaning}`,
                description: `${res.mnemonic}`,
                fields: [
                  new Field("References", `[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(query)})`)
                ],
                color: 0x3498db,
                thumbnail: {
                  url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(query).replace(/%/g, '')}.png`
                }
              }});
              break;
            case "kanji":
              return message.channel.send({embed: {
                title: `${query} - ${res.meaning.replace(/,/g, ", ")}`,
                description: `Radical: ${res.radical}`,
                fields: [
                  new Field("Onyomi", res.onyomi.replace(/,/g, '\u3001') || "n/a", true),
                  new Field("Kunyomi", res.kunyomi.replace(/,/g, '\u3001') || "n/a", true),
                  new Field("Mnemonic/Hint", res.mnemonic || "n/a"),
                  new Field("Examples", res.examples.map(ex => ex.split('|')[0]).join('\n') || "n/a", true),
                  new Field("Meaning", res.examples.map(ex => ex.split('|')[1]).join('\n') || "n/a", true),
                  new Field("References", `[Jisho](https://jisho.org/search/${encodeURI(query)})\u30fb[KanjiAlive](https://app.kanjialive.com/${encodeURI(query)})\u30fb[Tangorin](https://tangorin.com/kanji/${encodeURI(query)})\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(query)})`)
                ],
                color: 0x9b59b6,
                thumbnail: {
                  url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(query).replace(/%/g, '')}.png`
                }
              }});
              break;
            case "vocab":
              const VO_EMBED = {
                embed: {
                  title: `${query}`,
                  description: `Part of Speech: ${res.lexicalClass}`,
                  fields: [
                    new Field("Meaning", res.meaning.replace(/,/g, ", "), true),
                    new Field("Reading", res.reading.replace(/,/g, ", "), true),
                    new Field("Meaning Explanation", res.meaningExplanation || "n/a"),
                    new Field("Reading Explanation", res.readingExplanation || "n/a"),
                    new Field("Examples", res.context.map(ex => ex.split('|')[0]).join('\n') || "n/a", true),
                    new Field("Meaning", res.context.map(ex => ex.split('|')[1]).join('\n') || "n/a", true),
                    new Field("References", `[Jisho](https://jisho.org/search/${encodeURI(query)})\u30fb[Tangorin](https://tangorin.com/definition/${encodeURI(query)})\u30fb[WaniKani](https://www.wanikani.com/vocabulary/${encodeURI(query)})\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(query)})`)
                  ],
                  color: 0xe91e63,
                  thumbnail: {
                    url: `http://en.ikanji.jp/user_data/images/upload/character/original/${encodeURI(query).replace(/%/g, '')}.png`
                  }
                }
              };
              if(res.recording !== null) VO_EMBED.files = [res.recording.split(',')[0]];
              return message.channel.send(VO_EMBED);
              break;
            case "sc":
              const SC_EMBED = {embed: {
                title: `${query} - ${res.en.split(';')[0]}`,
                description: `Radical: ${res.ra}`,
                fields: [
                  new Field("Pinyin", res.py.join('\u3001'), true),
                  new Field("Zhuyin", (await zyc(res.py.join(' '))).join('\u3001').replace(/`/g, "\\`"), true),
                  new Field("Definition", res.en),
                  new Field("Context Examples", res.ex.map(ex => ex.replace('\u3010', "\u3010`").replace('\u3011|', "`\u3011*").trim() + '*').join('\n') || "n/a"),
                  new Field("References", `[Cojak](http://www.cojak.org/index.php?function=code_lookup&term=${query.charCodeAt(0).toString(16).toUpperCase()})\u30fb[MDBG](https://www.mdbg.net/chinese/dictionary?wdqb=${encodeURI(query)})\u30fb[Purple Culture](https://www.purpleculture.net/dictionary-details/?word=${encodeURI(query)})\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(query)})`)
                ],
                color: 0x9b59b6
              }};
              if(res.img) SC_EMBED.embed.thumbnail = { url: res.img };
              else {
                SC_EMBED.files = [{
                  attachment: `https://dictionary.writtenchinese.com/giffile.action?&localfile=true&fileName=${encodeURI(encodeURI(query))}.gif`,
                  name: `so.gif`
                }];
              }
              embed = await message.channel.send(SC_EMBED);
              if(!res.img) await db.collection('sc').updateOne({_id: query}, {$set: { img: embed.attachments.array()[0].url }}); // don't update if one exists already
              return embed;
              break;
            case "hsk":
              const HSK_EMBED = {
                embed: {
                  title: `${query}`,
                  fields: [
                    new Field("Pinyin", res.py, true),
                    new Field("Zhuyin", (await zyc(res.py)).join('\n').replace(/`/g, "\\`"), true),
                    new Field("Definition", res.en),
                    new Field("Examples", res.ex.splice(0, 2).map(ex => ex.replace('\u3010', '\n').replace('\u3011', '').replace('|', '\n*"').trim() + '"*').join('\n\n') || "n/a"),
                    new Field("Examples", res.ex.map(ex => ex.replace('\u3010', '\n').replace('\u3011', '').replace('|', '\n*"').trim() + '"*').join('\n\n') || "n/a"),
                    new Field("References", `[MDBG](https://www.mdbg.net/chinese/dictionary?wdqb=${encodeURI(query)})\u30fb[Purple Culture](https://www.purpleculture.net/dictionary-details/?word=${encodeURI(query)})\u30fb[Written Chinese](https://dictionary.writtenchinese.com/#sk=${encodeURI(query)}&svt=pinyin)\u30fb[Wiktionary](https://en.wiktionary.org/wiki/${encodeURI(query)})`)
                  ],
                  color: 0xe91e63
                },
                files: ["https://dictionary.writtenchinese.com/sounds/" + (await pyc(res.py)).split(' ').map(p => p.match(/[1-4]$/) ? p : p+5).join('') + ".mp3"]
              };
              // HSK_EMBED.files = ["https://dictionary.writtenchinese.com/sounds/" + (await pyc(res.py)) + ".mp3"];
              // console.log(HSK_EMBED);
              return message.channel.send(HSK_EMBED);
              break;
          }
        }
      }).catch(err => {throw err});
    }
  },
  convert: {
    desc: "convert kana into romaji and hiragana",
    params: "[kana]",
    exec: (message, query) => {
      message.channel.send(`${wanakana.toHiragana(query)} (${wanakana.toRomaji(query)})`);
    }
  },
  /*add: {
    desc: "add a particular item into lesson queue (mostly for debug)",
    params: "[type] [query]",
    exec: (message, type, query) => {
      if(!type) return message.channel.send("Missing type. [radical|kanji|vocab]");
      if(type !== "radical" && type !== "kanji" && type !== "vocab") return message.channel.send("Invalid type. [radical|kanji|vocab]");
      if(!query) return message.channel.send("Missing query.");
      db.collection('user').findOne({_id: message.author.id}).then(async usr => {
        if(usr === null) return message.react("\u2049\ufe0f");
        if(await db.collection(type).findOne({_id: query}) === null) return message.channel.send(`**${query}** was not found in **${type}**.`);
        usr[type][query] = new SRSObj();
        usr.lessons.push(new queuedLesson(query, TYPES[type].id, LEARN, Date.now()));
        usr.lessons.sort((a,b) => a.time - b.time);
        const PAYLOAD = {
          lessons: usr.lessons
        };
        PAYLOAD[`${type}.${query}`] = usr[type][query];
        console.log(PAYLOAD);
        await db.collection('user').updateOne({_id: message.author.id}, {$set: PAYLOAD}, {upsert: true});
        message.react("\uD83C\uDD97");
      });
    }
  },*/
  skip: {
    desc: "Skip a stage (if you already know it)",
    params: "[type] [levelNumber] (lang)",
    exec: (message, type, query, lang) => {
      // if(message.author.id !== "188350841600606209") return message.channel.send("broken atm btww");
      if(isNaN(query)) return message.channel.send("Invalid/missing query.");
      db.collection('user').findOne({_id: message.author.id}).then(async usr => {
        if(usr === null) return message.react("\u2049\ufe0f");
        if(!type || !TYPES[type]) return message.channel.send("Missing/invalid type. [radical|kanji|vocab|hskr|sc|hsk]");
        if(lang === undefined) lang = TYPES[type].lang;
        if(Object.keys(usr.lessons).length === 1) lang = Object.keys(usr.lessons)[0];
        if(usr.lessons[lang] === undefined) return message.channel.send(`Invalid lang. [${Object.keys(usr.lessons).join('|')}] (${lang})`);
        switch(lang){
          case "jp":
            if(type !== "radical" && type !== "kanji" && type !== "vocab") return message.channel.send("Invalid type. [radical|kanji|vocab]");
            break;
          case "hsk":
            if(type === "radical") type = "hskr";
            else if(type === "hanzi") type = "hanzi";
            else if(type === "vocab") type = "hsk";
            if(type !== "hskr" && type !== "sc" && type !== "hsk") return message.channel.send("Invalid type. [radical/hskr|hanzi/sc|vocab/hsk]");
            break;
        }
        levelNumber = parseInt(query);
        if(usr.next[type]-1 !== levelNumber) return message.channel.send(`You cannot skip **Stage ${query} ${type}**, you can only skip __Stage ${usr.next[type]-1} ${type}__`);
        const PAYLOAD = {
          lessons: usr.lessons[lang],
        };
        const newLessons = [];
        let one = true;
        (await db.collection(TYPES[type].db).findOne({_id: "lv"+levelNumber}))[type==="hskr"?"scn":"content"].forEach(char => {
          PAYLOAD[`${type}.${char}`] = new SRSObj();
          PAYLOAD[`${type}.${char}`].level = 4;
          PAYLOAD[`${type}.${char}`].levelOld = 4;
          let offset = 0;
          if(message.content.includes("force")){
            if(!one){
              PAYLOAD[`${type}.${char}`].level = PAYLOAD[`${type}.${char}`].levelOld = 5;
              offset = 60000;
            }
            one = false;
          }
          PAYLOAD[`${type}.${char}`].incorrect = 0;
          for(let i = PAYLOAD.lessons.length-1; i >= 0; i --){
            // console.log(PAYLOAD.lessons[i]);
            if(PAYLOAD.lessons[i].char === char && PAYLOAD.lessons[i].type === TYPES[type].id){
              PAYLOAD.lessons.splice(i, 1);
              //break;
            }
          }
          newLessons.push(new queuedLesson(char, TYPES[type].id, REVIEW, Date.now()+offset));
        });
        // console.log(newLessons);
        PAYLOAD.lessons.push(...newLessons);
        PAYLOAD.lessons.sort((a,b) => a.time - b.time);
        PAYLOAD[`lessons.${lang}`] = PAYLOAD.lessons; // instead of having to spam PAYLOAD[lang].lessons, i just reassign it at the end lol
        delete PAYLOAD.lessons;
        // console.log(PAYLOAD);
        await db.collection('user').updateOne({_id: message.author.id}, {$set: PAYLOAD}, {upsert: true});
        message.react("\uD83C\uDD97");
      });
    }
  },
  initialize: {
    alias: ["init"],
    desc: "update for new user, idk its kinda dumb",
    params: "[lang]",
    exec: (message, lang) => {
      if(lang !== "jp" && lang !== "hsk") return message.channel.send("```md\n# Supported Types\n+ jp\n+ hsk\n```");
      db.collection('user').findOne({_id: message.author.id}).then(async usr => {
        if(usr === null) return message.react("\u2049\ufe0f");
        switch(lang.toLowerCase()){
          case "jp":
            if(Object.keys(usr.radical).length === 0){
              const radicals = {};
              (await db.collection('radical').findOne({_id: "lv1"})).content.forEach(char => radicals[char] = new SRSObj());
              const PAYLOAD = {
                radical: radicals
              };
              PAYLOAD["lessons.jp"] = Object.keys(radicals).map(char => new queuedLesson(char, RA, LEARN, Date.now()));
              await db.collection('user').updateOne({_id: message.author.id}, {$set: PAYLOAD});
              message.react("\uD83C\uDD97");
            }else return message.react("\u2049\ufe0f");
            break;
          case "hsk":
            if(usr.hskr === undefined) usr.hskr = {};
            if(Object.keys(usr.hskr).length === 0){
              const radicals = {};
              (await db.collection('radical').findOne({_id: "lv1"})).scn.forEach(char => radicals[char] = new SRSObj());
              const HPAYLOAD = {
                hskr: radicals,
                sc: {},
                hsk: {},
              };
              HPAYLOAD["next.hskr"] = 2;
              HPAYLOAD["next.sc"] = HPAYLOAD["next.hsk"] = 1;
              HPAYLOAD["lessons.hsk"] = Object.keys(radicals).map(char => new queuedLesson(char, HSK_RA, LEARN, Date.now()));
              await db.collection('user').updateOne({_id: message.author.id}, {$set: HPAYLOAD});
              message.react("\uD83C\uDD97");
            }else return message.react("\u2049\ufe0f");
            break;
        }
      })
    }
  },
  lesson: {
    alias: ["lessons"],
    desc: "view planned lesson overview",
    params: "[lang]",
    exec: (message, lang, arg) => {
      db.collection('user').findOne({_id: message.author.id}).then(async usr => {
        if(usr === null) return message.react("\u2049\ufe0f");
        if(Object.keys(usr.lessons).length === 1) lang = Object.keys(usr.lessons)[0];
        if(usr.lessons[lang] === undefined) return message.channel.send(`No lesson for **${lang}**. Options: ${Object.keys(usr.lessons).join(', ')}`);
        if(usr.lessons[lang].length === 0) return message.react("\u2049\ufe0f");
        if(intervals[message.author.id] === undefined){
          intervals[message.author.id] = 1;
          setInterval(() => {
            message.author.send({embed: {title: "24HR Reminder", color: 0xf1c40f}});
          }, 8.64e7);
        }
        if(usr.lessons[lang][0].time < Date.now()){
          const contents = [...new Array(9)].map(() => []);
          const availableLessons = [];
          const LESSON_SIZE_OVERRIDE = parseInt(arg) || MAXIMUM_LESSON_SIZE;
          let lessonWeight = 0;
          for(let i = 0; i < usr.lessons[lang].length; i ++){
            const lesson = usr.lessons[lang][i];
            if(arg === "force"){
                   if(lesson.time > Date.now()+8.64e7 || lessonWeight >= LESSON_SIZE_OVERRIDE) break;
            } else if(lesson.time > Date.now() || lessonWeight >= LESSON_SIZE_OVERRIDE) break;
            // if(contents[lesson.type] === undefined) contents[lesson.type] = [];
            contents[lesson.type].push(lesson.lessonType === LEARN ? `**${lesson.char}**` : lesson.char);
            lessonWeight += TYPES[lesson.type].w; // Radicals have weight=1, kanji/vocab have weight=2
            availableLessons.push(lesson);
          }
          const LESSON_EMBED = {embed: {
            title: "Lesson Content",
            footer: {},
            timestamp: Date.now(),
            color: 0xf1c40f,
          }};
          switch(lang){
            case "jp":
              LESSON_EMBED.embed.fields = [
                new Field("Radicals", contents[0].join('\u3001') || "n/a"),
                new Field("Kanji", contents[1].join('\u3001') || "n/a"),
                new Field("Vocabulary", contents[2].join('\u3001') || "n/a")
              ];
              LESSON_EMBED.embed.footer.text = `${contents[0].length}R\u30fb${contents[1].length}K\u30fb${contents[2].length}V`;
              break;
            case "hsk":
              LESSON_EMBED.embed.fields = [
                new Field("Radicals", contents[3].join('\u3001') || "n/a"),
                new Field("Hanzi", contents[4].join('\u3001') || "n/a"),
                new Field("Vocabulary", contents[5].join('\u3001') || "n/a")
              ];
              LESSON_EMBED.embed.footer.text = `${contents[3].length}R\u30fb${contents[4].length}H\u30fb${contents[5].length}V`;
              break;
          }
          LESSON_EMBED.embed.footer.text += `\u30fb${usr.lessons[lang].filter(l => l.time < Date.now()).length} / ${usr.lessons[lang].length}`;
          message.channel.send(LESSON_EMBED).then(async embed => {
            await embed.react("\u23ed\ufe0f");
            lessons[message.author.id] = new Lesson(message.author.id, lang, embed, availableLessons);
          });
        }else{
          message.channel.send({embed: {
            title: "You're all caught up for now!",
            // description: `Your next lesson is at **${new Date(usr.lessons[lang][0].time)}** in \`${msToHMS(usr.lessons[lang][0].time-Date.now())}\``,
            timestamp: usr.lessons[lang][0].time, // Date.now(),
            footer: {
              text: "Next lesson at"
            },
            color: 0xe67e22,
          }});
          if(timeouts[message.author.id] !== undefined){
            timeouts[message.author.id] = 1;
            setTimeout(() => {
              message.author.send({embed: {title: "Your next lesson is ready!", color: 0xf1c40f}});
              delete timeouts[message.author.id];
            }, usr.lessons[lang][0].time-Date.now());
          }
        }
      });
    }
  },
  quit: {
    alias: ["abort"],
    desc: "Terminate an ongoing lesson prematurely.",
    exec: (message) => {
      if(lessons[message.author.id] === undefined) return message.react("\u2049\ufe0f");
      lessons[message.author.id].terminate(message);
    }
  }
};
const helpcmdtext = Object.keys(cmds).join('\n');

MongoClient.connect(process.env.DB_LINK, { useNewUrlParser: true, useUnifiedTopology: true }, function(err, mongoclient) {
  assert.equal(null, err);
  log.pass("Connected successfully to server");
  db = mongoclient.db(process.env.DB_NAME);
  Object.keys(cmds).filter(k => cmds[k].alias).forEach(k => cmds[k].alias.forEach(a => cmds[a] = cmds[k]));
  client.login(process.env.TOKEN);
});

let sid, mention;
let sdto; function refresh(){ clearTimeout(sdto); sdto = setTimeout(async () => { await client.destroy(); log.info("CRLF - Client timeout"); process.exit(); }, 1.728e8); log.pass(`updated to ${Date.now()+1.728e8}`); }
client.on("ready", () => {
  sid = client.user.id;
  mention = `<@!${sid}>`;
  log.pass(`Logged in as ${client.user.tag} - ${sid}`);
  client.user.setPresence({ game: { name: 'a', type: 0} });
  refresh();
});
client.on('message', (message) => {
  if(message.author.id === client.user.id || message.author.bot || message.author.createdAt > MINIMUM_AGE) return;
  if(!message.content.startsWith(mention) && !message.content.startsWith(process.env.PREFIX)){
    if(lessons[message.author.id] && message.channel.id === lessons[message.author.id].channel.id && lessons[message.author.id].contents[0].lessonType === REVIEW && lessons[message.author.id].sentPrompt)
      return lessons[message.author.id].advance(message);
    if(message.guild !== null) return; // only ignore if not in guild and doesn't have prefixes
  }

  // standard commands
  const cmd = message.content.replace(mention, '').replace(process.env.PREFIX, '').split(' ')[0];
  if(!cmds[cmd]) return;
  const parameters = [message].concat(message.content.replace(mention, '').replace(process.env.PREFIX, '').split(' ').slice(1));

  console.log(typeof cmd + " = " + cmd);
  console.log(typeof parameters + " = " + parameters.slice(1).toString());
  try {
    cmds[cmd].exec(...parameters);
  } catch (err) {
    log.error("Something broke with " + message.content);
    throw err;
  }
});
client.on('messageReactionAdd', async (messageReaction, user) => {
  if(lessons[user.id] && messageReaction.message.id === lessons[user.id].message.id && messageReaction.emoji.name === "\u23ed\ufe0f" && (lessons[user.id].contents[0].lessonType === LEARN || lessons[user.id].prevState === LEARN || lessons[user.id].prevState === NOT_STARTED_YET)){
    await messageReaction.message.edit({embed: {
      description: "*marked as read*"
    }});
    lessons[user.id].advance(messageReaction.message);
  }
});
