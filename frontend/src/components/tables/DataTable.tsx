import { useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { Pagination } from '../ui/Pagination'

export type DataTableColumn<T> = {
  key: string
  header: string
  render: (row: T) => ReactNode
  align?: 'left' | 'right'
  width?: string
  sortAccessor?: (row: T) => string | number
}

type DataTableProps<T> = {
  columns: DataTableColumn<T>[]
  rows: T[]
  getRowKey: (row: T) => string
  pageSize?: number
}

type SortState = { key: string; direction: 'asc' | 'desc' } | null

export function DataTable<T>({ columns, rows, getRowKey, pageSize = 10 }: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>(null)
  const [currentPage, setCurrentPage] = useState(1)

  const sortColumn = sort ? columns.find((c) => c.key === sort.key) : undefined
  const sortedRows =
    sort && sortColumn?.sortAccessor
      ? [...rows].sort((a, b) => {
          const av = sortColumn.sortAccessor!(a)
          const bv = sortColumn.sortAccessor!(b)
          const cmp = av < bv ? -1 : av > bv ? 1 : 0
          return sort.direction === 'asc' ? cmp : -cmp
        })
      : rows

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const page = Math.min(currentPage, pageCount)
  const pageRows = sortedRows.slice((page - 1) * pageSize, page * pageSize)

  function toggleSort(column: DataTableColumn<T>) {
    if (!column.sortAccessor) return
    setCurrentPage(1)
    setSort((prev) => {
      if (prev?.key !== column.key) return { key: column.key, direction: 'asc' }
      if (prev.direction === 'asc') return { key: column.key, direction: 'desc' }
      return null
    })
  }

  return (
    <div>
      <div className="overflow-x-auto mb-2">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              {columns.map((column) => {
                const isSorted = sort?.key === column.key
                return (
                  <th
                    key={column.key}
                    style={{ width: column.width }}
                    aria-sort={isSorted ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={`px-4 py-2.5 font-mono text-xs tracking-wide whitespace-nowrap text-muted uppercase ${
                      column.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {column.sortAccessor ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className={`inline-flex items-center gap-1 hover:text-ink ${
                          column.align === 'right' ? 'flex-row-reverse' : ''
                        }`}
                      >
                        {column.header}
                        {isSorted ? (
                          sort!.direction === 'asc' ? (
                            <ChevronUp size={12} aria-hidden="true" />
                          ) : (
                            <ChevronDown size={12} aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDown size={12} aria-hidden="true" className="opacity-40" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr key={getRowKey(row)} className="border-b border-line last:border-b-0 hover:bg-paper">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-4 py-3 text-ink ${column.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sortedRows.length > pageSize && (
        <Pagination
          page={page}
          pageCount={pageCount}
          onPageChange={setCurrentPage}
          className="border-t border-line"
        />
      )}
    </div>
  )
}
