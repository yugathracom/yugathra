import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

// Frontend එක සමඟ සම්බන්ධ වීමට CORS සක්‍රීය කිරීම
app.use('/*', cors())

// පරීක්ෂා කිරීම සඳහා මූලික රූට් එකක්
app.get('/', (c) => {
  return c.text('Yugathra Backend is running on Cloudflare Workers!')
})

// උදාහරණයක් ලෙස ඔබේ පැරණි ඇඩ්මින් ලොගින් හෝ වෙනත් API රූට්ස් මෙලෙස එකතු කළ හැක
app.post('/api/v1/admin/login', async (c) => {
  try {
    const body = await c.req.json()
    // මෙහිදී දත්ත පරීක්ෂා කිරීමේ කටයුතු සිදු කළ හැක
    return c.json({ success: true, message: 'Login successful' })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

export default app