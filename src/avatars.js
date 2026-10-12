'use strict';
// Employee photos: a small cache of who has a photo, and the avatar markup used across the pages.
const { all } = require('./db');
const { esc } = require('./util');

let cache = null;
const photos = () => (cache ??= new Map(all('SELECT id, photo FROM employees WHERE photo IS NOT NULL').map((r) => [r.id, r.photo])));
const reset = () => { cache = null; };

// Employee id of a row: rows that carry employee_id (leave, attendees...) use it, others are employee rows themselves
const idOf = (o) => (o ? Number(o.employee_id ?? o.id) : 0);

// Inside an .avatar element: the photo when there is one, otherwise the initials
function makeFace(initials) {
  return (o) => {
    const id = idOf(o), p = id && photos().get(id);
    if (!p) return esc(initials(o));
    return `<img src="/employees/${id}/photo?v=${encodeURIComponent(p.split('/').pop().slice(0, 8))}" alt="" loading="lazy">`;
  };
}

module.exports = { makeFace, reset, photos };
