'use strict';

// Создание первого администратора.
// Использование:
//   npm run init-admin                      (логин и пароль вводятся интерактивно)
//   ADMIN_INITIAL_PASSWORD=... ADMIN_LOGIN=... npm run init-admin   (разово, без интерактива)
// Пароль нигде не печатается и не сохраняется, кроме Argon2id-хеша в БД.

const readline = require('node:readline');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db/database');
const { countAdmins, createAdmin, getAdminByLogin } = require('../src/db/admins');
const { hashPassword, MIN_PASSWORD_LENGTH } = require('../src/utils/crypto');

const DEFAULT_LOGIN = 'admin';
const LOGIN_RE = /^[A-Za-z0-9_.-]{3,64}$/;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Нет интерактивного ввода. Задайте ADMIN_INITIAL_PASSWORD.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Скрываем эхо ввода пароля.
      rl._writeToOutput = str => {
        if (str.includes(question)) rl.output.write(str);
      };
    }
    rl.question(question, answer => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  try {
    if (countAdmins(db) > 0) {
      console.error('Администратор уже существует. Смена пароля — через интерфейс администратора.');
      process.exitCode = 1;
      return;
    }

    const envLogin = process.env.ADMIN_LOGIN;
    const envPassword = process.env.ADMIN_INITIAL_PASSWORD;

    let login = (envLogin || '').trim() || DEFAULT_LOGIN;
    let password = envPassword;

    if (!password) {
      const answer = (await ask(`Логин администратора [${DEFAULT_LOGIN}]: `)).trim();
      login = answer || DEFAULT_LOGIN;
      password = await ask('Пароль администратора: ', { hidden: true });
      const confirm = await ask('Повторите пароль: ', { hidden: true });
      if (password !== confirm) {
        console.error('Пароли не совпадают.');
        process.exitCode = 1;
        return;
      }
    }

    if (!LOGIN_RE.test(login)) {
      console.error('Логин: 3–64 символа, латиница, цифры, _ . -');
      process.exitCode = 1;
      return;
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      console.error(`Пароль: минимум ${MIN_PASSWORD_LENGTH} символов.`);
      process.exitCode = 1;
      return;
    }
    if (getAdminByLogin(db, login)) {
      console.error('Логин уже занят.');
      process.exitCode = 1;
      return;
    }

    const hash = await hashPassword(password);
    createAdmin(db, login, hash);
    console.log(`Администратор «${login}» создан.`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
});
