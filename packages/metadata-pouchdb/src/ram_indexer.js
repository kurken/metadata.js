/**
 * ### Кеш первого уровня - по датам
 * с функцией поиска в этом кеше
 *
 * @module indexer
 *
 * Created by Evgeniy Malyarov on 29.09.2018.
 */

const debug = require('debug')('wb:indexer');

// компаратор сортировки
function sort_fn(a, b) {
  if (a.date < b.date){
    return -1;
  }
  else if (a.date > b.date){
    return 1;
  }
  else{
    return 0;
  }
}

export default class RamIndexer {

  constructor({fields, search_fields, mgr}) {

    this._fields = fields;
    this._search_fields = search_fields;
    this._mgr = mgr;
    this._count = 0;
    this._ready = false;

    // кеш по дате
    this.by_date = {};
  }

  // сортирует кеш
  sort() {
    debug('sorting');
    for(const date in this.by_date) {
      this.by_date[date].sort(sort_fn);
    }
    this._ready = true;
    debug('ready');
  }

  // помещает документ в кеш
  put(indoc, force) {
    const doc = {};
    this._fields.forEach((fld) => {
      if(indoc.hasOwnProperty(fld)) {
        doc[fld] = indoc[fld];
      }
    });
    const date = doc.date.substr(0,7);
    const arr = this.by_date[date];
    if(arr) {
      if(force || !arr.some((row) => {
        if(row._id === doc._id) {
          Object.assign(row, doc);
          return true;
        }
      })){
        arr.push(doc);
        !force && arr.sort(sort_fn);
      }
    }
    else {
      this.by_date[date] = [doc];
    }
  }

  // возаращает фрагмент кеша по датам
  get_range(from, till, step, desc) {
    if(desc) {
      if(step) {
        let [year, month] = till.split('-');
        month = parseInt(month, 10) - step;
        while (month < 1) {
          year = parseInt(year, 10) - 1;
          month += 12;
        }
        till = `${year}-${month.pad(2)}`;
      }
      if(till < from) {
        return null;
      }
      let res = this.by_date[till];
      if(!res) {
        res = [];
      }
      return res;
    }
    else {
      if(step) {
        let [year, month] = from.split('-');
        month = parseInt(month, 10) + step;
        while (month > 12) {
          year = parseInt(year, 10) + 1;
          month -= 12;
        }
        from = `${year}-${month.pad(2)}`;
      }
      if(from > till) {
        return null;
      }
      let res = this.by_date[from];
      if(!res) {
        res = [];
      }
      return res;
    }
  }

  // перебирает кеш в диапазоне дат
  find({selector, sort, ref, limit, skip = 0}, {branch}) {

    if(!this._ready) {
      throw new Error('Индекс прочитн не полностью, повторите запрос позже');
    }

    // извлекаем значения полей фильтра из селектора
    let dfrom, dtill, from, till, search, department, state;
    for(const row of selector.$and) {
      const fld = Object.keys(row)[0];
      const cond = Object.keys(row[fld])[0];
      if(fld === 'date') {
        if(cond === '$lt' || cond === '$lte') {
          dtill = row[fld][cond];
          till = dtill.substr(0,7);
        }
        else if(cond === '$gt' || cond === '$gte') {
          dfrom = row[fld][cond];
          from = dfrom.substr(0,7);
        }
      }
      else if(fld === 'search') {
        search = row[fld][cond] ? row[fld][cond].toLowerCase().split(' ') : [];
      }
      else if(fld === 'department') {
        department = cond ? row[fld][cond] : row[fld];
      }
      else if(fld === 'state') {
        state = cond ? row[fld][cond] : row[fld];
      }
    }

    if(sort && sort.length && sort[0][Object.keys(sort[0])[0]] === 'desc' || sort === 'desc') {
      sort = 'desc';
    }
    else {
      sort = 'asc';
    }

    const {_search_fields, _mgr} = this;
    const partners = branch.partners._obj.map(({acl_obj}) => acl_obj);
    const divisions = branch.divisions._obj.map(({acl_obj}) => acl_obj);

    let part,
      // выборка диапазона кеша
      step = 0,
      // флаг поиска страницы со ссылкой
      flag = skip === 0 && _mgr._owner.$p.utils.is_guid(ref),
      // результат поиска строки со ссылкой
      scroll = 0,
      count = 0;

    const docs = [];

    function add(doc) {
      count++;
      if(flag && doc._id.endsWith(ref)) {
        scroll = count - 1;
        flag = false;
      }
      if(skip > 0) {
        return skip--;
      }
      if(limit > 0) {
        limit--;
        docs.push(doc);
      }
    }

    function check(doc) {

      // фильтруем по дате
      if(doc.date < dfrom || doc.date > dtill) {
        return;
      }

      // фильтруем по контрагенту acl
      if(doc.partner && partners.length && !partners.includes(doc.partner)) {
        return;
      }

      // фильтруем по подразделению acl
      if(doc.department && divisions.length && !divisions.includes(doc.department)) {
        return;
      }

      // фильтруем по строке
      let ok = true;
      for(const word of search) {
        if(!word) {
          continue;
        }
        if(!_search_fields.some((fld) => {
          const val = doc[fld];
          return val && typeof val === 'string' && val.toLowerCase().includes(word);
        })){
          ok = false;
          break;
        }
      }

      ok && add(doc);
    }

    // получаем очередной кусочек кеша
    while(part = this.get_range(from, till, step, sort === 'desc')) {
      step += 1;
      // фильтруем
      if(sort === 'desc') {
        for(let i = part.length - 1; i >= 0; i--){
          check(part[i]);
        }
      }
      else {
        for(let i = 0; i < part.length; i++){
          check(part[i]);
        }
      }
    }

    return {docs, scroll, flag, count};
  }

  // формирует начальный дамп
  init(bookmark) {

    if(!bookmark) {
      this._mgr.on('change', (change) => this.put(change));
      debug('start');
    }

    this._mgr.pouch_db.find({
      selector: {
        class_name: this._mgr.class_name,
      },
      fields: this._fields,
      bookmark,
      limit: 10000,
    })
      .then(({bookmark, docs}) => {
        this._count += docs.length;
        debug(`received ${this._count}`);
        for(const doc of docs) {
          this.put(doc, true);
        }
        debug(`indexed ${this._count} ${bookmark.substr(10, 30)}`);
        if(docs.length < 10000) {
          this.sort();
        }
        else {
          this.init(bookmark);
        }
      });
  }
}

