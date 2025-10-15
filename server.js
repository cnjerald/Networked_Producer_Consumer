const express = require('express');
const { engine } = require('express-handlebars');
const path = require('path');

const app = express();

// Tell Express to use .hbs instead of .handlebars
app.engine('hbs', engine({ extname: '.hbs' }));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// Optional static folder
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.render('home', { title: 'Home Page', message: 'This one sends' });
});

// Start the server
const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
