///////////////////////////////////////////////////////////
// FancyTree.dragDrop.js
// Stuff to assist with drag and drop.
///////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////
// Constants
///////////////////////////////////////////////////////////

var DRAG_TO_ABOVE_SENSITIVITY_RATIO = 0.30;
var DRAG_TO_BELOW_SENSITIVITY_RATIO = 0.70;


///////////////////////////////////////////////////////////
// jQuery.draggable/droppable parameter setting
///////////////////////////////////////////////////////////

FancyTree.prototype.setDraggableDroppable = function(row, rowTypeParams) {
    var itemRow = this.getItemRow(row);

    if (!rowTypeParams) {
        rowTypeParams = this.getRowTypeParams(row);
    }

    // configure drag & drop
    if (rowTypeParams.draggableParams) {
        itemRow.draggable(rowTypeParams.draggableParams);
    }

    if (rowTypeParams.droppableParams) {
        itemRow.droppable(rowTypeParams.droppableParams);
    }
};

FancyTree.prototype.getDraggableParams = function() {
    var self = this;

    return {
            axis: 'y',
            containment: 'document',
            cursorAt: { top: -30, left: 5 },
            distance: 5,
            delay: 50,
            helper: function(e, ui)
            {
                return '<div class="ftDragHelper"/>';
            },
            revert: 'invalid',
            revertDuration: 300,
            scroll: true,
            start: function(evt, ui) {
                self.draggableStart.call(self, evt);
                evt.stopPropagation();
                return true;
            },
            stop: function(e, ui) {
                self.resetDragDropState.call(self);
            }
        };
};

FancyTree.prototype.getDroppableParams = function() {
    var self = this;
    return {
        tolerance: 'pointer',
        hoverClass: 'ftDragOver',
        accept: function(e) {
            // //DEBUG console.log('accept:', self.canAcceptDropTo);
            return self.canAcceptDropTo;
        },
        drop: function(evt, ui) {
            return;
            self.onItemRowDrop(evt, ui);
            evt.stopPropagation();
            return false;
        }
    };
};

FancyTree.prototype.getGenericDroppableParams = function() {
    var self = this;
    return {
        accept: '*',
        tolerance: 'pointer',
        hoverClass: 'ftDragOver',
        drop: function(evt, ui) {
            self.onItemRowDrop(evt, ui);
            evt.stopPropagation();
            return false;
        }
    };
};


///////////////////////////////////////////////////////////
// State management
///////////////////////////////////////////////////////////

FancyTree.prototype.resetDragDropState = function() {
    this.dragging = false;
    this.canAcceptDropTo = false;
    this.draggingOverRow = null;
    this.draggingTo = null;
    $('.ftDragToChild').removeClass('ftDragToChild');
    this.hideDragInsertBar();
};


///////////////////////////////////////////////////////////
// Event handlers
///////////////////////////////////////////////////////////

FancyTree.prototype.draggableStart = function(evt) {
    var self = this;
    var target = $(evt.target);
    var row = self.getParentRowNode(target);
    var rowTypeParams = self.getRowTypeParams(row);
    var droppableParams = self.getGenericDroppableParams();

    self.dragging = true;
    self.dropping = false;
    self.draggingRow = self.getParentRowNode(target);
    self.canAcceptDropTo = false;
    self.dragSelectedCollapsedRow = false;

    self.root.find('.ftChildren').droppable(droppableParams);
    self.hideTooltip.call(self);

    var isCollapsed = target.parent().hasClass('ftCollapsed');
    var hiddenRowCount = 0;
    var $lastAutoSelectedRow = null;

    if (evt.ctrlKey) {
        self.clearMultiSelection.call(self);
        self.toggleMultiSelectionSingle.call(self, row.attr('id'), true);
        self.dragToreOffParent = true;
    }
    else {
        self.dragToreOffParent = false;
        if (self.multiSelection.length == 0 || !(target.parent().hasClass('ftSelected')))
        {
            self.clearMultiSelection.call(self);
            self.toggleMultiSelectionSingle.call(self, row.attr('id'), true);

            self.dragSelectedCollapsedRow = isCollapsed;

            if (!isCollapsed && self.autoSelectChildrenOnDrag && rowTypeParams.permitAutoSelectChildren) {
                // select every child too by default; holding ctrl and click+dragging will just grab the parent
                row.children('.ftChildren').find('.ftRowNode').each(function(i, e) {
                        var $e = $(e);
                        if ($e.parents('.ftCollapsed').length > 0) {
                            return;
                        }
                        self.toggleMultiSelectionSingle.call(self, $e.attr('id'), true);
                        $lastAutoSelectedRow = $e;
                    });
            }

            if ($lastAutoSelectedRow) {
                $lastAutoSelectedRow.addClass('ftDrawAttention');
                setTimeout(function() { $lastAutoSelectedRow.removeClass('ftDrawAttention'); }, 200);
            }
        }

        if (evt.shiftKey) {
            // ALL children should be autoselected
            var $children = $('#' + self.multiSelection.join(',#')).find('.ftRowNode');
            $children.each(function(i, e) {
                self.toggleMultiSelectionSingle.call(self, e.attributes.id.value, true);
            });
        }
        else if (rowTypeParams.autoselectChildrenOnDrag) {
            // ensure all children of collapsed nodes are also selected
            var $collapsedRows = $('#' + self.multiSelection.join('.ftCollapsed,#') + '.ftCollapsed');
            var $collapsedUnselectedChildren = $collapsedRows.find('.ftRowNode:not(.ftSelected)');
            $collapsedUnselectedChildren.each(function(i, e) {
                self.toggleMultiSelectionSingle.call(self, e.attributes.id.value, true);
            });

            // count up collapsed+selected children (hidden rows)
            var $collapsedSelectedChildren = $collapsedRows.find('.ftRowNode.ftSelected');
            hiddenRowCount = $collapsedSelectedChildren.length;
        }
    }

    this.updateDragHelper(evt, hiddenRowCount);
};

FancyTree.prototype.onItemRowMouseMove = function(evt) {
    var treeObj = evt.data.treeObj;

    if (!treeObj.dragging) {
        return;
    }

    var over = $(evt.target);
    var overRow = treeObj.getParentRowNode(over);
    var draggingParams = treeObj.getRowTypeParams(treeObj.draggingRow);
    var allowedDropTargets = draggingParams.allowedDropTargets;
    var draggingToRowType = overRow.attr('rowtype');

    var canAcceptDropTo = (allowedDropTargets.indexOf(draggingToRowType) >= 0);
    if (!canAcceptDropTo) {
        return;
    }

    treeObj.canAcceptDropTo = true;
    treeObj.draggingOverRow = overRow;

    $('.ftDragToChild').removeClass('ftDragToChild');
    treeObj.hideDragInsertBar.call(treeObj);

    var overItemRow = treeObj.getItemRow(overRow);
    var overItemRowContent = treeObj.getItemRowContent(overRow);

    var rowHeight = overItemRow.height();
    var topDelta = evt.pageY - overItemRow.offset().top;
    var deltaPct = topDelta / rowHeight;

    var drag;
    var dragInsertBarTarget;

    var children = treeObj.getChildrenContainer(overRow).children();
    var isCollapsed = overRow.hasClass('ftCollapsed');
    var underRoot = overRow.parent().parent().hasClass('ftRoot');

    if (deltaPct <= DRAG_TO_ABOVE_SENSITIVITY_RATIO) {
        // to above position
        if (underRoot && draggingParams.allowAtTopLevel && allowedDropTargets.indexOf('ROOT') >= 0) {
            drag = ['before', overItemRow];
        }
        else if (!underRoot || (draggingParams.allowAtTopLevel && allowedDropTargets.indexOf('ROOT') >= 0))
        {
            drag = ['before', overItemRowContent];
        }
        else if (!underRoot && !(draggingParams.allowAtChildLevel)) {
            treeObj.canAcceptDropTo = false;
            return;
        }
        else if (children.length == 0 || isCollapsed) {
            // to child (within)
            drag = ['append', overItemRowContent];
        }
        else {
            drag = ['after', overItemRowContent];
        }
    }
    else if (underRoot && !(draggingParams.allowAtChildLevel)) {
        drag = ['before', overItemRow];
    }
    else if (deltaPct >= DRAG_TO_BELOW_SENSITIVITY_RATIO) {
        // to below position
        if (children.length > 0 && !isCollapsed)
        {
            // insert before first child of hovered row
            drag = ['before', treeObj.getItemRowContent(children.first())];
        }
        else {
            if (underRoot && children.length == 0) {
                // to child (within)
                drag = ['append', overItemRowContent];
            }
            else {
                // insert below hovered row (as sibling)
                drag = ['after', overItemRowContent];
            }
        }
    }
    else {
        // to middle position (middle of a row)
        if (children.length > 0 && !isCollapsed) {
            //drag = ['before', treeObj.getItemRowContent(children.first())];
            drag = ['prepend', overItemRowContent];
        }
        else {
            // to child (within)
            drag = ['append', overItemRowContent];
        }
    }

    treeObj.drawDragInsertBar.call(treeObj, drag[0], drag[1], treeObj.getParentRowNode(drag[1]).attr('rowtype'));
    treeObj.draggingTo = drag[0];
    treeObj.draggingOverRow = treeObj.getParentRowNode(drag[1]);
};

FancyTree.prototype.onItemRowDrop = function(evt, ui) {
    if (this.dropping) {
        return;
    }
    if (!this.canAcceptDropTo || !this.draggingOverRow) {
        return;
    }

    this.dropping = true;
    var $rows = this.root.find('#' + this.multiSelection.join(',#')).not(this.draggingOverRow);

    if ($rows.length == 0) {
        return;
    }

    // add required descendants of dragged rows with rowtype.alwaysMoveChildren=true
    var $rows = this.addRequiredChildrenToDraggedRows($rows);

    var fxAreOff = $.fx.off;
    if (($rows.length == 1 && !this.dragToreOffParent) || this.dragSelectedCollapsedRow) {
        // don't animate single row movements, it is just annoying; we'll still use normal
        // animation if the ctrl key is held however, because this probably means a parent
        // was torn off with ctrl and those moves can be rather confusing (children popping
        // out of parent)
        // TODO just call moveDraggedRows() (fix the bug we get when calling it first..?)
        $.fx.off = true;
    }


    var self = this;
    this.moveDraggedRowsAnimate($rows, this.draggingTo, this.draggingOverRow, function(moves) {
        $.fx.off = fxAreOff;
        if (self.onDragDrop) {
            self.onDragDrop(moves);
        }
        setTimeout(function() { self.dropping = false; }, 1000);
    });
};


///////////////////////////////////////////////////////////
// Drag helper floaty tip
///////////////////////////////////////////////////////////

FancyTree.prototype.updateDragHelper = function(evt, hiddenRowCount) {
    var helperTip;
    if (evt.ctrlKey) {
        helperTip = 'Dragging hovered row.';
    }
    else if (evt.shiftKey) {
        helperTip = 'Autoselected children.';
    }
    else if (self.autoSelectChildrenOnDrag) {
        helperTip = 'Ctrl+drag: drag just the hovered row.';
    }
    else {
        helperTip = 'Shift+drag: also drag all children rows.';
    }
    helperTip += '<br/>' + 'Esc: cancel drag.';

    $('.ftDragHelper').html(
        '<div class="ftDragHelperMessage">Moving ' + this.multiSelection.length + ' row' + (this.multiSelection.length == 1 ? '' : 's')
        + (hiddenRowCount > 0 ? ' (' + hiddenRowCount + ' hidden)' : '')
        + '</div><div class="ftDragHelperFooter">'
        + helperTip
        + '</div>'
    );
};


///////////////////////////////////////////////////////////
// Drag positional insert bar
///////////////////////////////////////////////////////////

FancyTree.prototype.drawDragInsertBar = function(dragToPosition, targetElem, targetRowType) {
    var offset = targetElem.offset();
    var left = offset.left;
    var top = offset.top;
    var width = targetElem.width();
    var height = targetElem.height();

    switch (dragToPosition) {
        case 'before':
            this.drawDragInsertBarAt(targetRowType, left, top - 1, width, 0);
            break;
        case 'after':
            this.drawDragInsertBarAt(targetRowType, left, top + height + 3, width, 0);
            break;
        case 'prepend':
            this.getParentRowNode(targetElem).addClass('ftDragToChild');
            this.hideDragInsertBar();
            break;
        case 'append':
            this.getParentRowNode(targetElem).addClass('ftDragToChild');
            this.hideDragInsertBar();
            break;
    }
};

FancyTree.prototype.drawDragInsertBarAt = function(targetRowType, left, top, width, height) {
    var bar = $('#ftDragInsertBar');
    bar.attr('targetrowtype', targetRowType);
    if (bar.length == 0) {
        bar = $('<div/>', { id: 'ftDragInsertBar' });
        $('body').append(bar);
    }
    //DEBUG console.log('set bar css to: LTRB', left, top, width, height);
    bar.css({ left: left, top: top, width: width, height: height });
    bar.show();

    var droppableParams = this.getGenericDroppableParams;
    bar.droppable(droppableParams);
};

FancyTree.prototype.hideDragInsertBar = function() {
    $('#ftDragInsertBar').hide();
};


///////////////////////////////////////////////////////////
// Moving dragged rows
///////////////////////////////////////////////////////////

FancyTree.prototype.moveDraggedRowsAnimate = function($rows, moveToPosition, $moveToRow, onComplete) {
    var self = this;

    if ($rows.length == 0) {
        throw new Error('Nothing to move');
    }

    var defaultRowHeight = 0;
    $rows.each(function(i, e) {
        var height = $(e).children('.ftItemRow').height();
        if (height > defaultRowHeight) {
            defaultRowHeight = height;
        }
    });

    var moves;
    self.slideOutAndShrink.call(self, $rows, defaultRowHeight, function(heights) {
        moves = self.moveDraggedRows.call(self, $rows, moveToPosition, $moveToRow);
        self.growAndSlideIn.call(self, $rows, heights, function() {
            // TODO make it possible to pass moves to onComplete right after moveDraggedRows, and give
            // it a callback to call when IT is done with its operations; that callback would then
            // complete the animation after the function has had the time to do any move ops of its own
            if (onComplete) {
                onComplete(moves);
            }
        });
    });
};

FancyTree.prototype.moveDraggedRows = function($rows, moveToPosition, $moveToRow) {
    var moves = this.planMovingDraggedRows($rows, moveToPosition, $moveToRow);
    var movesDone = this.performMovingDraggedRows(moves);
    this.reconfigureDraggedRows([]); // TODO only reconfigure the rows affected
    var $commonAncestor = $rows.parents().has($rows).first();
    return movesDone;
};

FancyTree.prototype.addRequiredChildrenToDraggedRows = function($rows) {
    var $newrows = $();

    for (var i = 0; i < $rows.length; i++) {
        var $row = $($rows[i]);
        var params = this.getRowTypeParams($row);
        var collapsed = $row.hasClass('ftCollapsed');
        if (params.alwaysMoveChildren || collapsed) {
            // add all descendants of the row
            $newrows = $newrows.add($row.find('.ftRowNode'));
        }
    }

    return $rows.add($newrows); // will remove duplicates automagically
};

FancyTree.prototype.performMovingDraggedRows = function(moves) {
    var movesDone = [];

    for (var i = 0; i < moves.length; i++) {
        var move = moves[i];
        if (move.relation == 'nomove') {
            movesDone.push(move);
            continue;
        }
        movesDone.push(this.moveRowRel(move.row, move.relation, move.to, true));
    }

    return movesDone;
};

FancyTree.prototype.reconfigureDraggedRows = function($topParents) {
    var $fixups;
    if ($topParents.length == 0) {
        // just moving to/from root level, update everybody
        $fixups = this.root.find('.ftRowNode');
    }
    else {
        // only do potentially affected nodes
        $fixups = $topParents.find('.ftRowNode').add($topParents);
    }

    // reconfigure all possibly affected nodes in a moment
    var self = this;
    $fixups.each(function(i, e) {
        var $e = $(e);
        self.setDraggableDroppable.call(self, $e);
        self.updateRowExpander.call(self, $e);
        self.setRowButtonTooltips.call(self, $e);
        self.formatRowTitle.call(self, $e);
    });
};

FancyTree.prototype.findNearestInsertPoint = function($row, $notIn, lookForward) {
    if (lookForward) {
        return this.findNearestInsertPointAfter($row, $notIn);
    }
    return this.findNearestInsertPointBefore($row, $notIn);
};

FancyTree.prototype.findNearestInsertPointBefore = function($row, $notIn) {
    var $prev = $row.prevUntil().not($notIn).first();
    if ($prev.length == 1) {
        return ['after', $prev];
    }

    var $parent = $row.parent().parent();
    if ($parent.is($notIn)) {
        return this.findNearestInsertPointBefore($parent, $notIn);
    }

    return ['prepend', $parent];
};

FancyTree.prototype.findNearestInsertPointAfter = function($row, $notIn) {
    var $next = $row.nextUntil().not($notIn).first();
    if ($next.length == 1) {
        return ['before', $next];
    }

    var $parent = $row.parent().parent();
    if ($parent.is($notIn)) {
        return this.findNearestInsertPointAfter($parent, $notIn);
    }

    return ['append', $parent];
};


FancyTree.prototype.planMovingDraggedRows = function($rows, relation, $toRow) {
    var initialRows = [];
    var self = this;
    $rows.each(function(i, e) {
        var $e = $(e);
        var $csp = $e.parent().closest($rows); // Closest Selected Parent
        initialRows.push([$e, $csp]);
    });

    var insertPoint = [relation, $toRow];
    if ((relation == 'after' || relation == 'before') && $toRow.is($rows)) {
        // shift insert point to nearest unselected row before/after $toRow
        insertPoint = this.findNearestInsertPoint($toRow, $rows,
            (relation == 'after'));
    }

    var $lastCsp;
    var $lastCspChild;

    var moves = [];
    for (var i = 0; i < initialRows.length; i++) {
        var $row = initialRows[i][0];
        var $csp = initialRows[i][1];

        if ($row.is($toRow)) {
            if (relation == 'prepend' || relation == 'append') {
                // trying to make row a child of itself; deny this
                moves.push({ row: $row, relation: 'nomove' });
                continue;
            }
        }

        if ($csp.length == 0) {
            // no closest selected parent; insert at insertPoint
            moves.push({ row: $row, relation: insertPoint[0], to: insertPoint[1] });
        }
        else {
            // have a CSP; make us the first or last child of the CSP
            if ($lastCsp && $lastCsp.is($csp)) {
                moves.push({ row: $row, relation: 'after', to: $lastCspChild });
            }
            else if (relation == 'append') {
                moves.push({ row: $row, relation: 'append', to: $csp });
            }
            else {
                moves.push({ row: $row, relation: 'prepend', to: $csp });
            }

            $lastCsp = $csp;
            $lastCspChild = $row;
        }

        if (insertPoint[0] == 'prepend' || $csp.length == 0) {
            // put insert point after inserted row
            insertPoint[0] = 'after';
            insertPoint[1] = $row;
        }
    }

    // DEBUG
    var ids = [];
    $rows.each(function(i, e) { ids.push(e.id); });
    console.log('plan results for',
        '$rows', ids.join(', '),
        'relation', relation,
        '$toRow', $toRow.attr('id'));
    for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        console.log((1 + i) + '. ' + m.row.attr('id'), m.relation,
            m.relation != 'nomove' ? m.to.attr('id') : '');
    }

    return moves;
}
