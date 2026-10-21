import code from 'eve/extensions/code'
export default code({
  worker: { model: 'openai/gpt-6.1-sol', reasoning: 'high' }
})
