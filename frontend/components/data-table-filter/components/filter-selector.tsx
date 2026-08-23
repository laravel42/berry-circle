import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { ArrowRightIcon, ChevronRightIcon, FilterIcon } from 'lucide-react'
import {
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import React from 'react'
import type {
  Column,
  ColumnDataType,
  DataTableFilterActions,
  FilterModel,
  FilterStrategy,
  FiltersState,
} from '../core/types'
import { DEFAULT_OPERATORS } from '../core/operators'
import { isAnyOf } from '../lib/array'
import { getColumn } from '../lib/helpers'
import { type Locale, t } from '../lib/i18n'
import { FilterValueController } from './filter-value'

interface FilterSelectorProps<TData> {
  filters: FiltersState
  columns: Column<TData>[]
  actions: DataTableFilterActions
  strategy: FilterStrategy
  locale?: Locale
  iconOnly?: boolean
}

export const FilterSelector = memo(__FilterSelector) as typeof __FilterSelector

function createDraftFilter<TData, TType extends ColumnDataType>(
  column: Column<TData, TType>,
): FilterModel<TType> {
  return {
    columnId: column.id,
    type: column.type,
    operator: DEFAULT_OPERATORS[column.type].multiple,
    values: [],
  } as unknown as FilterModel<TType>
}

function __FilterSelector<TData>({
  filters,
  columns,
  actions,
  strategy,
  locale = 'en',
  iconOnly = false,
}: FilterSelectorProps<TData>) {
  const [open, setOpen] = useState(false)
  const [property, setProperty] = useState<string | undefined>(undefined)

  const column = property ? getColumn(columns, property) : undefined
  const filter = property
    ? filters.find((f) => f.columnId === property)
    : undefined

  const hasFilters = filters.length > 0
  const activeFilter =
    property && column ? (filter ?? createDraftFilter(column)) : undefined

  return (
    <Popover
      open={open}
      onOpenChange={async (value) => {
        setOpen(value)
        if (!value) setTimeout(() => setProperty(undefined), 100)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-7 border-border/40 bg-board-column-body shadow-none hover:bg-board-column-body hover:text-foreground',
            hasFilters && 'w-fit !px-2',
            iconOnly && 'px-2',
          )}
          aria-label={t('filter', locale)}
        >
          <FilterIcon className="size-4" />
          {!hasFilters && !iconOnly && <span>{t('filter', locale)}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-fit p-0 origin-(--radix-popover-content-transform-origin)"
      >
        <div className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))]">
          {property && column && activeFilter ? (
            <div className="min-w-[11rem] max-w-[16rem] overflow-y-auto border-r border-border">
              <FilterValueController
                filter={activeFilter}
                column={column as Column<TData, ColumnDataType>}
                actions={actions}
                strategy={strategy}
                locale={locale}
              />
            </div>
          ) : null}
          <Command loop className="min-w-[8.5rem]">
            <CommandEmpty>{t('noresults', locale)}</CommandEmpty>
            <CommandList className="max-h-fit">
              <CommandGroup>
                {columns.map((column) => (
                  <FilterableColumn
                    key={column.id}
                    column={column}
                    isActive={property === column.id}
                    setProperty={setProperty}
                  />
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function FilterableColumn<TData, TType extends ColumnDataType, TVal>({
  column,
  isActive = false,
  setProperty,
}: {
  column: Column<TData, TType, TVal>
  isActive?: boolean
  setProperty: (value: string) => void
}) {
  const itemRef = useRef<HTMLDivElement>(null)

  const prefetch = useCallback(() => {
    column.prefetchOptions()
    column.prefetchValues()
    column.prefetchFacetedUniqueValues()
    column.prefetchFacetedMinMaxValues()
  }, [column])

  const openNested = useCallback(() => {
    prefetch()
    setProperty(column.id)
  }, [column.id, prefetch, setProperty])

  useEffect(() => {
    const target = itemRef.current

    if (!target) return

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const isSelected = target.getAttribute('data-selected') === 'true'
          if (isSelected) prefetch()
        }
      }
    })

    observer.observe(target, {
      attributes: true,
      attributeFilter: ['data-selected'],
    })

    return () => observer.disconnect()
  }, [prefetch])

  return (
    <CommandItem
      ref={itemRef}
      value={column.id}
      keywords={[column.displayName]}
      onSelect={() => setProperty(column.id)}
      className={cn('group', isActive && 'bg-accent')}
      onMouseEnter={openNested}
      onFocus={openNested}
    >
      <div className="flex w-full items-center justify-between">
        <div className="inline-flex items-center gap-1.5">
          {<column.icon strokeWidth={2.25} className="size-4" />}
          <span>{column.displayName}</span>
        </div>
        <ArrowRightIcon
          className={cn(
            'size-4 opacity-0 group-aria-selected:opacity-100',
            isActive && 'opacity-100',
          )}
        />
      </div>
    </CommandItem>
  )
}

interface QuickSearchFiltersProps<TData> {
  search?: string
  filters: FiltersState
  columns: Column<TData>[]
  actions: DataTableFilterActions
  strategy: FilterStrategy
  locale?: Locale
}

export const QuickSearchFilters = memo(
  __QuickSearchFilters,
) as typeof __QuickSearchFilters

function __QuickSearchFilters<TData>({
  search,
  filters,
  columns,
  actions,
  strategy,
  locale = 'en',
}: QuickSearchFiltersProps<TData>) {
  if (!search || search.trim().length < 2) return null

  const cols = useMemo(
    () =>
      columns.filter((c) =>
        isAnyOf<ColumnDataType>(c.type, ['option', 'multiOption']),
      ),
    [columns],
  )

  return (
    <>
      {cols.map((column) => {
        const filter = filters.find((f) => f.columnId === column.id)
        const options = column.getOptions()
        const optionsCount = column.getFacetedUniqueValues()

        function handleOptionSelect(value: string, check: boolean) {
          if (check) actions.addFilterValue(column, [value])
          else actions.removeFilterValue(column, [value])
        }

        return (
          <React.Fragment key={column.id}>
            {options.map((v) => {
              const checked = Boolean(filter?.values.includes(v.value))
              const count = optionsCount?.get(v.value) ?? 0

              return (
                <CommandItem
                  key={v.value}
                  value={v.value}
                  keywords={[v.label, v.value]}
                  onSelect={() => {
                    handleOptionSelect(v.value, !checked)
                  }}
                  className="group"
                >
                  <div className="flex items-center gap-1.5 group">
                    <Checkbox
                      checked={checked}
                      className="opacity-0 data-[state=checked]:opacity-100 group-data-[selected=true]:opacity-100 mr-1 border-muted-foreground/40 data-[state=checked]:border-violet-500 data-[state=checked]:bg-violet-500 data-[state=checked]:text-white"
                    />
                    <div className="flex items-center w-4 justify-center">
                      {v.icon &&
                        (isValidElement(v.icon) ? (
                          v.icon
                        ) : (
                          <v.icon className="size-4 text-primary" />
                        ))}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <span className="text-muted-foreground">
                        {column.displayName}
                      </span>
                      <ChevronRightIcon className="size-3.5 text-muted-foreground/75" />
                      <span>
                        {v.label}
                        <sup
                          className={cn(
                            !optionsCount && 'hidden',
                            'ml-0.5 tabular-nums tracking-tight text-muted-foreground',
                            count === 0 && 'slashed-zero',
                          )}
                        >
                          {count < 100 ? count : '100+'}
                        </sup>
                      </span>
                    </div>
                  </div>
                </CommandItem>
              )
            })}
          </React.Fragment>
        )
      })}
    </>
  )
}
