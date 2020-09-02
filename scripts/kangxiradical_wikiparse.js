function download(filename, text) {
  var element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
  element.setAttribute('download', filename);

  element.style.display = 'none';
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}
const json = {};
Array.from(document.getElementsByTagName("tbody")[2].children).forEach(Q => {
    const rad = Q.getElementsByTagName("span")[0].innerText;
    const content = Array.from(Q.getElementsByTagName("td")).map(td => td.innerText.replace(/[\n、\(\)]/g, ''));
    json[rad] = {
        id: parseInt(content[0]),
        variants: content[1],
        strokes: content[2],
        meaning: content[3],
        zh: content[4],
        vi: content[5],
        ja: content[6],
        ko: content[7],
        frequency: content[8],
        simplified: content[9],
        examples: content[10]
    };
    if(json[rad].variants.length > 1){
        json[rad].variants.split('').forEach(v => json[v]=json[rad]);
    }
});

download("kangxirads.json", JSON.stringify(json));
