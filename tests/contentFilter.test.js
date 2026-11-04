
'use strict';

const assert = require('node:assert/strict');

const {
    checkContent,
    maskProfanity,
    MODERATION_ACTIONS,
} = require('../backend/contentFilter');

const cases = [
    ['Xin chào các bạn', null],
    ['Các bạn đi học', null],
    ['cacao', null],
    ['bắc kỳ', MODERATION_ACTIONS.STRIKE_BAN],
    ['b.ắ.c k.ỳ', MODERATION_ACTIONS.STRIKE_BAN],
    ['c.ầ.n s.a', MODERATION_ACTIONS.INSTANT_BAN],
    ['đập đá', MODERATION_ACTIONS.INSTANT_BAN],
    ['cá độ', MODERATION_ACTIONS.INSTANT_BAN],
    ['f.u.c.k', MODERATION_ACTIONS.MASK],
    ['fuck', MODERATION_ACTIONS.MASK],
    ['Tôi muốn tự tử', MODERATION_ACTIONS.BLOCK_WARN],
    ['fuck và cá độ', MODERATION_ACTIONS.INSTANT_BAN],
];

for (const [text, action] of cases) {
    assert.equal(checkContent(text).action, action, text);
}

assert.equal(maskProfanity('f.u.c.k'), '*******');
assert.equal(maskProfanity('fuck và cá độ'), '**** và cá độ');

assert.equal(
    checkContent('fuck và cá độ').matches.length >= 2,
    true
);

console.log(`PASS: ${cases.length + 3} assertions`);
