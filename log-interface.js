module.exports = {
  info: (str) => console.log('\x1b[106m\x1b[36mINFO\x1b[0m ' + str.toString().replace(/\n/g, "\n     ")),
  pass: (str) => console.log('\x1b[102m\x1b[32mPASS\x1b[0m ' + str.toString().replace(/\n/g, "\n     ")),
  warn: (str) => console.log('\x1b[103m\x1b[33mWARN\x1b[0m ' + str.toString().replace(/\n/g, "\n     ")),
  error: (str) => console.log('\x1b[101m\x1b[31m!ERR\x1b[0m ' + str.toString().replace(/\n/g, "\n     ")),
}
