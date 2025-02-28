const path = require('path');
const http = require('http');
const compression = require('compression');
const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const socketIO = require('socket.io');
const uuid = require("uuid");

const version = process.env.npm_package_version;

const {Users} = require('./utils/users');
const {isRealString, validateUserName, avList} = require('./utils/validation');
const {makeid, keyformat} = require('./utils/functions');
const {Response403, Response404} = require('./utils/errorRes');


const apiRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minute
    max: 100, // limit each IP to 100 requests per windowMs
    message: "Too many requests. Temporarily blocked from PokeTab server. Please try again later",
    standardHeaders: false, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false // Disable the `X-RateLimit-*` headers
});

const publicPath = path.join(__dirname, '../public');
const port = process.env.PORT || 3000;

let app = express();
let server = http.createServer(app);
let io = socketIO(server);
let users = new Users();
const devMode = false;

const keys = new Map();
const uids = new Map();

function deleteKeys(){
  for (let [key, value] of keys){
    //console.dir(`${key} ${value.using}, ${value.created}, ${Date.now()}`);
    if (value.using != true && Date.now() - value.created > 120000){
      keys.delete(key);
      console.log(`Key ${key} deleted`);
    }
  }
}

setInterval(deleteKeys, 1000);

app.disable('x-powered-by');

//view engine setup
app.set('views', path.join(__dirname, '../public/views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 1);

app.use(cors());
app.use(compression());
app.use(express.static(publicPath));
app.use(express.json());
app.use(express.urlencoded({
  extended: false
}));

app.use(apiRequestLimiter);

app.get('/', (_, res) => {
    res.redirect('/login');
});

app.get('/login', (_, res) => {
  res.render('login', {title: 'Login', version: `v.${version}`, key: null, key_label: `Enter key <i id='lb__icon' class="fa-solid fa-key"></i>`});
});

app.get('/login/:key', (req, res)=>{
  const key_format = /^[0-9a-zA-Z]{3}-[0-9a-zA-Z]{3}-[0-9a-zA-Z]{3}-[0-9a-zA-Z]{3}$/;
  if (key_format.test(req.params.key)){
    res.render('login', {title: 'Login', key_label: `Checking <i id='lb__icon' class="fa-solid fa-circle-notch fa-spin"></i>` , version: `v.${version}`, key: req.params.key});
  }
  else{
    res.redirect('/');
  }
});

app.get('/create', (req, res) => {
  const key = makeid(12);
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null; //currently ip has nothing to do with our server. May be we can use it for user validation or attacts. 
  //console.log(`${ip} created key ${key}`);
  keys.set(key, {using: false, created: Date.now(), ip: ip});
  res.render('create', {title: 'Create', version: `v.${version}`, key: key});
});

app.get('/chat', (_, res) => {
  res.redirect('/');
});

app.post('/chat', (req, res) => {

  //console.log('Received chat request');

  let username = req.body.username;
  let key = req.body.key;
  let avatar = req.body.avatar;
  let maxuser = req.body.maxuser;

  if (!validateUserName(username)){
    res.status(400).send({
      error: 'Invalid username format. Please use only alphanumeric characters'
    });
  }
  if (!avList.includes(avatar)){
    res.status(400).send({
      error: 'Don\'t try to be oversmart. Choose avatar from the list'
    });
  }
  //get current users list on key
  if (keys.has(key) || devMode){
    let user = users.getUserList(key);
    let max_users = users.getMaxUser(key) ?? maxuser;
    let uid = uuid.v4();
    //console.log(user.length >= max_users);
    if (user.length >= max_users){
      //send unauthorized access message
      res.status(401).send({
        message: "Unauthorized access",
      });
    }else{
      res.render('chat', {myName: username, myKey: key, myId: uid, myAvatar: avatar, maxUser: max_users});
    }
  }else{
    //send invalid key message
    res.status(401).send({
      message: "Key no longer available"
    });
  }
});

app.get('/offline', (_, res) => {
  res.render('offline');
});

app.get('*', (_, res) => {
  res.send(Response404);
});

io.on('connection', (socket) => {

  socket.on('join', (params, callback) => {
    //console.log('Received join request');
    if (!isRealString(params.name) || !isRealString(params.key)) {
      return callback('empty');
    }
    if (params.avatar === undefined) {
      return callback('avatar');
    }
    let userList = users.getUserList(params.key);
    let user = userList.includes(params.name);
    if (user) {
      return callback('exists');
    }
    callback();
    keys.get(params.key) ? keys.get(params.key).using = true: null;
    socket.join(params.key);
    users.removeUser(params.id);
    uids.set(socket.id, params.id);
    users.addUser(params.id, params.name, params.key, params.avatar, params.maxuser || users.getMaxUser(params.key));
    io.to(params.key).emit('updateUserList', users.getAllUsersDetails(params.key));
    socket.emit('server_message', {color: 'limegreen', text: 'You joined the chat.🔥'}, 'join');
    socket.broadcast.to(params.key).emit('server_message', {color: 'limegreen', text: `${params.name} joined the chat.🔥`}, 'join');
    //console.log(`New user ${params.name} connected on key ${params.key} with avatar ${params.avatar} and maxuser ${params.maxuser || users.getMaxUser(params.key)}`);
  });


  socket.on('message', (message, type, messageId, uId, reply, replyId, options) => {
    //console.log('Received new message request');
    let user = users.getUser(uids.get(socket.id));
    if (user && isRealString(message)) {
      let id = uuid.v4();
      message = message.replace(/>/gi, "&gt;").replace(/</gi, "&lt;");
      socket.emit('messageSent', messageId, id);
      socket.broadcast.to(user.key).emit('newMessage', message, type, id, uId, reply, replyId, options);
      //console.log('Message sent');
    }
  });

  socket.on('react', (target, messageId, myId) => {
    //console.log('Received react request', target, messageId, myId);
    let user = users.getUser(uids.get(socket.id));
    if (user) {
      //send to all including sender
      io.to(user.key).emit('getReact', target, messageId, myId);
    }
  });


  socket.on('deletemessage', (messageId, msgUid, userName, userId) => {
    //console.log('Received delete message request');
    let user = users.getUser(uids.get(socket.id));
    if (user) {
      if (msgUid == userId){
        io.to(user.key).emit('deleteMessage', messageId, userName);
      }
    }
  });

  socket.on('createLocationMessage', (coord) => {
    //console.log('Received create location message request');
    let user = users.getUser(uids.get(socket.id));
    if (user) {
      io.to(user.key).emit('server_message', {color: 'limegreen', text: `<a href='https://www.google.com/maps?q=${coord.latitude},${coord.longitude}' target='_blank'><i class="fa-solid fa-location-dot" style="padding: 10px 5px 10px 0;"></i>${user.name}'s location</a>`, user: user.name}, 'location');
    }
  });


  socket.on('typing', () => {
    let user = users.getUser(uids.get(socket.id));
    if (user) {
      socket.broadcast.to(user.key).emit('typing', user.name, user.id + '-typing');
    }
  });
  socket.on('stoptyping', () => {
    let user = users.getUser(uids.get(socket.id));
    if (user) {
      socket.broadcast.to(user.key).emit('stoptyping', user.id + '-typing');
    }
  });


  socket.on('disconnect', () => {
    let user = users.removeUser(uids.get(socket.id));
    uids.delete(socket.id);
    if (user) {
      io.to(user.key).emit('updateUserList', users.getAllUsersDetails(user.key));
      io.to(user.key).emit('server_message', {color: 'orangered', text: `${user.name} left the chat.🐸`}, 'leave');
      console.log(`User ${user.name} disconnected from key ${user.key}`);
      let usercount = users.users.filter(datauser => datauser.key === user.key);
      if (usercount.length === 0) {
        users.removeMaxUser(user.key);
        //delete key from keys
        keys.delete(user.key);
        console.log(`Session ended with key: ${user.key}`);
      }
      console.log(`${usercount.length } users left`);
    }
  });


  socket.on('createRequest', (key, callback) => {
    if (!keyformat.test(key)){
      callback('Invalid key');
      return;
    }
    let keyExists = users.getUserList(key).length > 0;
    if (keyExists){
      socket.emit('createResponse', {exists: keyExists});
    }
    else{
      if (keys.has(key)) {
        if (keys.get(key).using == false){
          socket.emit('createResponse', {exists: keyExists});
        }
        else{
          callback('Key is already in use');
        }
      }
      else{
        callback('Expired or invalid key');
      }
    }
  });


  socket.on('joinRequest', (key, callback) => {
    if (!keyformat.test(key)){
      return;
    }
    let keyExists = users.getUserList(key).length > 0;
    if (keyExists){
      //check if max user is reached
      let user = users.getUserList(key);
      let max_users = users.getMaxUser(key) ?? 2;
      if (user.length >= max_users){
        callback(Response403);
      }else{
        socket.emit('joinResponse', {exists: keyExists, userlist: users.getUserList(key), avatarlist: users.getAvatarList(key)});
      }
    }
    else{
      socket.emit('joinResponse', {exists: keyExists});
    }
  });

});


server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
