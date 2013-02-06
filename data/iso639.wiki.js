$('table.sortable tr').map(function() {
    return new Array($('td', this).map(function() {
        return $(this).text()
    }).slice(1, 5).get())
}).get()