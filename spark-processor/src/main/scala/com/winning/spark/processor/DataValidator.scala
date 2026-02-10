package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions._
import com.winning.spark.config.{ProcessorConfig, ValidationRule}

class DataValidator extends DataProcessor {
  override def process(df: DataFrame, config: ProcessorConfig): DataFrame = {
    if (!config.validation.enabled) {
      return df
    }
    
    var result = df
    
    config.validation.rules.foreach { rule =>
      result = applyRule(result, rule)
    }
    
    result
  }
  
  private def applyRule(df: DataFrame, rule: ValidationRule): DataFrame = {
    var result = df
    
    // Required field validation (not null)
    if (rule.required) {
      result = result.filter(col(rule.field).isNotNull)
    }
    
    // Pattern validation (regex)
    rule.pattern.foreach { pattern =>
      result = result.filter(col(rule.field).rlike(pattern))
    }
    
    // Min value validation
    rule.min.foreach { min =>
      result = result.filter(col(rule.field) >= min)
    }
    
    // Max value validation
    rule.max.foreach { max =>
      result = result.filter(col(rule.field) <= max)
    }
    
    result
  }
}
